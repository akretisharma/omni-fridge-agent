import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createMicSegmenter } from '../audio.js';
import { fetchIntent, fetchOakStatus, purchaseItems, visionCheck } from '../api.js';

const SCAN_INTERVAL_MS = 3000; // one camera frame to OMNI every few seconds
const FLIP_CONFIRMATIONS = 2; // a status must hold for this many scans before it changes

const PHASE_LABEL = {
  idle: 'Start the camera to begin',
  listening: 'Hold the button to talk',
  hearing: 'Hearing you...',
  thinking: 'Thinking...',
  speaking: 'Speaking...',
};

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Loose match between what the model says ("the sugar") and the exact item names we hold.
function matchNames(spoken, known) {
  const norm = (s) => s.toLowerCase().trim();
  return known.filter((k) =>
    spoken.some((s) => norm(k) === norm(s) || norm(k).includes(norm(s)) || norm(s).includes(norm(k)))
  );
}

export default function CameraPage() {
  const navigate = useNavigate();
  const videoRef = useRef(null);
  const oakImgRef = useRef(null);
  const canvasRef = useRef(document.createElement('canvas'));
  const streamRef = useRef(null);
  const segmenterRef = useRef(null);
  const pendingSpeechRef = useRef(0); // utterances queued or playing
  const speechEtaRef = useRef(0);
  const announceFirstScanRef = useRef(false); // narrate the first result after a new goal
  const queueRef = useRef(Promise.resolve()); // utterances are handled one at a time, in order
  const scanBusyRef = useRef(false);
  const statusRef = useRef(new Map()); // ingredient -> { status, pending, count } (debounced)

  const [cameraOn, setCameraOn] = useState(false);
  const [oak, setOak] = useState(null); // /api/oak/status, or null while loading
  const [source, setSource] = useState('computer'); // 'computer' | 'oak'
  const [liveScan, setLiveScan] = useState(true);
  const [phase, setPhase] = useState('idle');
  const [level, setLevel] = useState(0);
  const [holding, setHolding] = useState(false);
  const [messages, setMessages] = useState([]); // { role: 'user' | 'omni' | 'error', text }
  const [typed, setTyped] = useState('');
  const [goal, setGoal] = useState(null); // { goal, ingredients }
  const [check, setCheck] = useState(null); // { present: [], missing: [] }
  const [visible, setVisible] = useState([]); // everything OMNI currently sees
  const [skipped, setSkipped] = useState(() => new Set());
  const [purchasing, setPurchasing] = useState(false);
  const [logLines, setLogLines] = useState([]);

  // Latest state for callbacks created once (mic loop, scan interval).
  const live = useRef({});
  live.current = { source, cameraOn, liveScan, goal, check, visible, skipped };

  const log = (msg, obj) => {
    const line = obj ? `${msg} ${JSON.stringify(obj)}` : msg;
    console.log(msg, obj || '');
    setLogLines((prev) => [line, ...prev].slice(0, 60));
  };
  const say = (role, text) => setMessages((prev) => [...prev, { role, text }].slice(-30));

  // ---------------------------------------------------------------------
  // Voice out (browser TTS). The mic ignores hands-free triggers while we
  // talk, so we don't hear ourselves; push-to-talk still barges in.
  // ---------------------------------------------------------------------
  function speak(text) {
    if (!text) return;
    try {
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.05;
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        pendingSpeechRef.current = Math.max(0, pendingSpeechRef.current - 1);
        if (pendingSpeechRef.current === 0) setPhase((p) => (p === 'speaking' ? 'listening' : p));
      };
      utter.onend = done;
      utter.onerror = done;
      pendingSpeechRef.current += 1;
      setPhase('speaking');
      // Utterances queue up. Chrome occasionally never fires onend, so also give
      // up after our own estimate rather than leaving the mic muted forever.
      const now = Date.now();
      speechEtaRef.current = Math.max(now, speechEtaRef.current) + 1500 + text.length * 90;
      setTimeout(done, speechEtaRef.current - now);
      speechSynthesis.speak(utter);
    } catch {
      /* speech synthesis not available - non-fatal */
    }
  }

  function stopSpeaking() {
    try {
      speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
    pendingSpeechRef.current = 0;
    speechEtaRef.current = 0;
  }

  // Default to the OAK camera when the backend can see one.
  useEffect(() => {
    fetchOakStatus()
      .then((st) => {
        setOak(st);
        if (st.available) setSource('oak');
      })
      .catch(() => setOak({ installed: false, available: false }));
  }, []);

  // ---------------------------------------------------------------------
  // Camera + mic
  // ---------------------------------------------------------------------
  async function start() {
    try {
      const useOak = source === 'oak';
      // The OAK isn't a webcam, so its video comes from the backend stream; the mic is still ours.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: useOak ? false : { width: { ideal: 1280 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      if (useOak) {
        await new Promise((resolve, reject) => {
          const img = oakImgRef.current;
          img.onload = resolve; // first MJPEG frame decoded
          img.onerror = () => reject(new Error('OAK camera stream failed - is it plugged in? See the server log.'));
          img.src = '/api/oak/stream';
        });
      } else {
        videoRef.current.srcObject = stream;
      }
      segmenterRef.current = await createMicSegmenter(stream, {
        canTrigger: () => false,
        onSpeechStart: () => setPhase('hearing'),
        onSegment: (blob) => enqueue(() => sendAudio(blob)),
        onDiscard: () => setPhase((p) => (p === 'hearing' ? 'listening' : p)),
        onLevel: setLevel,
      });
      setCameraOn(true);
      setPhase('listening');
      log(`Camera and mic started (${useOak ? 'OAK camera' : 'computer camera'}).`);
    } catch (err) {
      log('Start error:', err.message);
      alert('Could not access camera/microphone: ' + err.message);
    }
  }

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      segmenterRef.current?.stop();
      if (oakImgRef.current) oakImgRef.current.src = ''; // close the stream; backend then frees the USB device
      stopSpeaking();
    },
    []
  );

  function captureFrame(maxWidth = 640) {
    const isOak = live.current.source === 'oak';
    const el = isOak ? oakImgRef.current : videoRef.current;
    const w = isOak ? el?.naturalWidth : el?.videoWidth;
    const h = isOak ? el?.naturalHeight : el?.videoHeight;
    if (!w) return null;
    const scale = Math.min(1, maxWidth / w);
    const canvas = canvasRef.current;
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext('2d').drawImage(el, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7); // data:image/jpeg;base64,...
  }

  // ---------------------------------------------------------------------
  // Continuous scanning: every few seconds the latest frame goes to OMNI,
  // which reports what's visible and checks it against the current goal.
  // ---------------------------------------------------------------------
  async function scanOnce() {
    if (scanBusyRef.current) return;
    const frame = captureFrame();
    if (!frame) return;
    scanBusyRef.current = true;
    const goalAtStart = live.current.goal;
    const ingredients = goalAtStart?.ingredients ?? [];
    try {
      const result = await visionCheck(frame, ingredients);
      setVisible(result.visible);
      // The goal changed while this frame was being analysed: its checklist is stale.
      if (ingredients.length && live.current.goal === goalAtStart) applyScan(ingredients, result);
    } catch (err) {
      log('Scan error:', err.message);
    } finally {
      scanBusyRef.current = false;
    }
  }

  // Debounce so one flaky frame doesn't flip an item present/missing and trigger chatter.
  function applyScan(ingredients, result) {
    const isFirst = announceFirstScanRef.current;
    announceFirstScanRef.current = false;
    const statuses = statusRef.current;
    const nowPresent = [];
    const nowMissing = [];
    const becamePresent = [];

    for (const { name } of ingredients) {
      const seen = result.present.includes(name) ? 'present' : 'missing';
      let s = statuses.get(name);
      if (!s) {
        s = { status: seen, pending: null, count: 0 };
      } else if (seen === s.status) {
        s = { ...s, pending: null, count: 0 };
      } else {
        const count = s.pending === seen ? s.count + 1 : 1;
        if (count >= FLIP_CONFIRMATIONS) {
          s = { status: seen, pending: null, count: 0 };
          if (seen === 'present') becamePresent.push(name);
        } else {
          s = { ...s, pending: seen, count };
        }
      }
      statuses.set(name, s);
      (s.status === 'present' ? nowPresent : nowMissing).push(name);
    }

    setCheck({ present: nowPresent, missing: nowMissing });
    log('Scan:', { present: nowPresent, missing: nowMissing });

    if (isFirst) {
      const n = nowMissing.length;
      const text =
        n === 0
          ? "Good news, you've got everything."
          : `You're missing ${n} thing${n > 1 ? 's' : ''}: ${nowMissing.join(', ')}.`;
      say('omni', text);
      speak(text);
    } else if (becamePresent.length) {
      const text = nowMissing.length
        ? `I can see the ${becamePresent.join(' and ')} now. Still missing ${nowMissing.join(', ')}.`
        : `I can see the ${becamePresent.join(' and ')} now. You've got everything.`;
      say('omni', text);
      speak(text);
    }
  }

  useEffect(() => {
    if (!cameraOn || !liveScan) return undefined;
    const id = setInterval(() => {
      if (!document.hidden) scanOnce();
    }, SCAN_INTERVAL_MS);
    return () => clearInterval(id);
    // scanOnce reads everything through refs, so the interval never needs rebuilding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOn, liveScan]);

  // ---------------------------------------------------------------------
  // Voice requests: audio (or typed text) + the latest frame + current state
  // go to OMNI together; it replies with an action and something to say.
  // ---------------------------------------------------------------------
  function enqueue(job) {
    queueRef.current = queueRef.current.then(job).catch(() => {});
  }

  async function sendAudio(blob) {
    await sendIntent({ audioBase64: await blobToBase64(blob), audioFormat: 'wav' });
  }

  async function sendIntent(payload) {
    setPhase('thinking');
    const s = live.current;
    const body = {
      ...payload,
      imageBase64: s.cameraOn ? captureFrame() : null,
      goal: s.goal?.goal ?? null,
      ingredients: s.goal?.ingredients ?? [],
      present: s.check?.present ?? [],
      missing: s.check?.missing ?? [],
      skipped: [...s.skipped],
      visible: s.visible,
    };

    try {
      const r = await fetchIntent(body);
      log('Intent:', r);
      if (r.transcript) say('user', r.transcript);
      handleIntent(r);
    } catch (err) {
      say('error', err.message);
      log('Intent error:', err.message);
      setPhase('listening');
    }
  }

  function handleIntent(r) {
    const s = live.current;
    if (r.action === 'set_goal') {
      const next = { goal: r.goal, ingredients: r.ingredients };
      live.current.goal = next; // visible to the immediate scan below
      statusRef.current = new Map();
      setGoal(next);
      setCheck(null);
      setSkipped(new Set());
      announceFirstScanRef.current = true;
      if (s.cameraOn) scanOnce();
    } else if (r.action === 'skip_items' || r.action === 'unskip_items') {
      const targets = matchNames(r.items, s.check?.missing ?? []);
      setSkipped((prev) => {
        const next = new Set(prev);
        targets.forEach((n) => (r.action === 'skip_items' ? next.add(n) : next.delete(n)));
        return next;
      });
    }

    if (r.reply) {
      say('omni', r.reply);
      speak(r.reply);
    } else {
      setPhase('listening');
    }
  }

  function submitTyped(e) {
    e.preventDefault();
    const text = typed.trim();
    if (!text) return;
    setTyped('');
    stopSpeaking();
    enqueue(() => sendIntent({ transcript: text }));
  }

  function talkDown(e) {
    e.currentTarget.setPointerCapture(e.pointerId);
    stopSpeaking(); // barge in over whatever OMNI is saying
    setHolding(true);
    setPhase('hearing');
    segmenterRef.current?.setPushToTalk(true);
  }

  function talkUp() {
    setHolding(false);
    segmenterRef.current?.setPushToTalk(false);
  }

  function toggleSkip(name) {
    setSkipped((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }

  // ---------------------------------------------------------------------
  // Purchase via Zip, then show the results on the Purchases page
  // ---------------------------------------------------------------------
  async function purchase() {
    const toBuy = check.missing.filter((n) => !skipped.has(n));
    if (toBuy.length === 0) {
      alert('Nothing left to purchase.');
      return;
    }
    setPurchasing(true);
    try {
      const items = toBuy.map((name) => {
        const match = goal.ingredients.find((i) => i.name === name);
        return { name, quantity: match?.quantity || 1, unit: match?.unit || 'unit' };
      });
      const { results } = await purchaseItems(items, goal.goal);
      log('Purchase results:', results);

      const approved = results.filter((r) => r.status === 'approved').length;
      const pending = results.filter((r) => r.status === 'pending' || r.status === 'submitted').length;
      speak(
        `Submitted ${results.length} purchase${results.length > 1 ? 's' : ''} to Zip. ` +
          `${approved} approved, ${pending} pending approval.`
      );
      navigate('/purchases');
    } catch (err) {
      log('Purchase error:', err.message);
      alert('Purchase failed: ' + err.message);
      setPurchasing(false);
    }
  }

  return (
    <main>
      <section className="camera-panel">
        <div className="video-wrap">
          <video ref={videoRef} autoPlay playsInline muted hidden={source === 'oak'} />
          <img ref={oakImgRef} alt="OAK camera" className="oak-feed" hidden={source !== 'oak'} />
          {cameraOn && <span className="live-badge">● LIVE</span>}
        </div>
        <div className="camera-controls">
          <label className="toggle">
            Camera:
            <select value={source} onChange={(e) => setSource(e.target.value)} disabled={cameraOn}>
              <option value="computer">Computer camera</option>
              <option value="oak" disabled={!oak?.available}>
                {oak?.available ? 'OAK camera (Luxonis)' : 'OAK camera (not detected)'}
              </option>
            </select>
          </label>
          <button onClick={start} disabled={cameraOn}>
            {cameraOn ? 'Camera and mic on' : 'Start camera and mic'}
          </button>
          <label className="toggle">
            <input type="checkbox" checked={liveScan} onChange={(e) => setLiveScan(e.target.checked)} />
            Continuously scan the camera (every {SCAN_INTERVAL_MS / 1000}s)
          </label>
        </div>
        <h3>👁️ What OMNI sees</h3>
        <ul className="list">
          {visible.length === 0 && <li className="muted">nothing yet</li>}
          {visible.map((v) => (
            <li key={v}>{v}</li>
          ))}
        </ul>
      </section>

      <section className="control-panel">
        <div className={`status status-${phase}`}>
          <span>{PHASE_LABEL[phase]}</span>
          <div className="meter">
            <div style={{ width: `${Math.min(100, level * 600)}%` }} />
          </div>
        </div>

        <button
          className={`talk-btn${holding ? ' recording' : ''}`}
          disabled={!cameraOn}
          onPointerDown={talkDown}
          onPointerUp={talkUp}
          onPointerCancel={talkUp}
        >
          {holding ? 'Recording... release to send' : 'Hold to talk (interrupts OMNI)'}
        </button>

        <div className="chat">
          {messages.length === 0 && (
            <p className="hint">Try saying: "I'm baking a chocolate cake", then "skip the sugar".</p>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.text}
            </div>
          ))}
        </div>

        <form className="typed" onSubmit={submitTyped}>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="...or type a request"
          />
          <button type="submit" disabled={!typed.trim()}>
            Send
          </button>
        </form>

        {goal && (
          <div className="block">
            <h2>Goal: {goal.goal}</h2>
            <h3>Needed</h3>
            <ul className="list">
              {goal.ingredients.map((ing) => (
                <li key={ing.name}>
                  {ing.name}
                  {ing.quantity ? ` (${ing.quantity} ${ing.unit || ''})` : ''}
                </li>
              ))}
            </ul>
            {!check && <p className="hint">Checking the camera...</p>}
          </div>
        )}

        {check && (
          <div className="block">
            <h2>Inventory check (live)</h2>
            <h3>✅ Present</h3>
            <ul className="list">
              {check.present.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
            <h3>❌ Missing</h3>
            <ul className="list editable">
              {check.missing.map((name) => (
                <li
                  key={name}
                  className={skipped.has(name) ? 'skipped' : ''}
                  onClick={() => toggleSkip(name)}
                >
                  {name}
                </li>
              ))}
            </ul>
            <p className="hint">Click an item (or say "skip the ...") to skip buying it.</p>
            <button className="wide" onClick={purchase} disabled={purchasing}>
              {purchasing ? 'Submitting to Zip...' : 'Purchase missing items via Zip'}
            </button>
          </div>
        )}
      </section>

      <section className="log-panel">
        <h2>Log</h2>
        <pre>{logLines.join('\n')}</pre>
      </section>
    </main>
  );
}
