import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchIntent, purchaseItems, visionCheck } from '../api.js';

function speak(text) {
  // Browser TTS for narration - reliable and zero extra API calls. Swap for
  // OMNI's own voice output if/when you want the "adaptive voice/tone"
  // criterion to run through OMNI end-to-end instead.
  try {
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.05;
    speechSynthesis.speak(utter);
  } catch {
    /* speech synthesis not available - non-fatal */
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Browser speech-to-text fallback, used when "Send raw audio to OMNI" is
// unchecked. Recognition runs while the talk button is held; stop() ends it.
function startBrowserTranscription() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) throw new Error('SpeechRecognition not supported in this browser');
  const rec = new SpeechRecognition();
  rec.lang = 'en-US';
  const result = new Promise((resolve, reject) => {
    rec.onresult = (e) => resolve(e.results[0][0].transcript);
    rec.onerror = (e) => reject(new Error(e.error));
    rec.onend = () => reject(new Error('No speech detected'));
  });
  rec.start();
  return { stop: () => rec.stop(), result };
}

export default function CameraPage() {
  const navigate = useNavigate();
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const transcriberRef = useRef(null);
  const pressedRef = useRef(false);

  const [cameraOn, setCameraOn] = useState(false);
  const [useOmniAudio, setUseOmniAudio] = useState(true);
  const [recording, setRecording] = useState(false);
  const [transcript, setTranscript] = useState('Say something like: "I\'m baking a chocolate cake"');
  const [goal, setGoal] = useState(null); // { goal, ingredients }
  const [scanning, setScanning] = useState(false);
  const [check, setCheck] = useState(null); // { present: [], missing: [] }
  const [skipped, setSkipped] = useState(() => new Set());
  const [purchasing, setPurchasing] = useState(false);
  const [logLines, setLogLines] = useState([]);

  const log = (msg, obj) => {
    const line = obj ? `${msg} ${JSON.stringify(obj)}` : msg;
    console.log(msg, obj || '');
    setLogLines((prev) => [line, ...prev].slice(0, 50));
  };

  // Release the camera when leaving the page.
  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  // ---------------------------------------------------------------------
  // Camera (this computer's webcam)
  // ---------------------------------------------------------------------
  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      setCameraOn(true);
      log('Camera started.');
    } catch (err) {
      log('Camera error:', err.message);
      alert('Could not access camera: ' + err.message);
    }
  }

  function captureFrame() {
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.85); // data:image/jpeg;base64,...
  }

  // ---------------------------------------------------------------------
  // Push-to-talk: hold the button to record audio for OMNI
  // ---------------------------------------------------------------------
  async function onTalkDown(e) {
    e.currentTarget.setPointerCapture(e.pointerId);
    pressedRef.current = true;
    try {
      if (useOmniAudio) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const chunks = [];
        const recorder = new MediaRecorder(stream);
        recorder.ondataavailable = (ev) => chunks.push(ev.data);
        recorder.chunks = chunks;
        recorderRef.current = recorder;
        recorder.start();
        // Button was released while the mic permission prompt / startup was pending.
        if (!pressedRef.current) return void onTalkUp();
      } else {
        transcriberRef.current = startBrowserTranscription();
      }
      setRecording(true);
    } catch (err) {
      pressedRef.current = false;
      log('Mic error:', err.message);
      alert('Could not access microphone: ' + err.message);
    }
  }

  async function onTalkUp() {
    pressedRef.current = false;
    const recorder = recorderRef.current;
    const transcriber = transcriberRef.current;
    if (!recorder && !transcriber) return;
    recorderRef.current = null;
    transcriberRef.current = null;
    setRecording(false);
    setTranscript('Thinking...');

    try {
      let body;
      if (recorder) {
        const blob = await new Promise((resolve) => {
          recorder.onstop = () => {
            recorder.stream.getTracks().forEach((t) => t.stop());
            resolve(new Blob(recorder.chunks, { type: 'audio/webm' }));
          };
          recorder.stop();
        });
        body = { audioBase64: await blobToBase64(blob), audioFormat: 'webm' };
      } else {
        transcriber.stop();
        body = { transcript: await transcriber.result };
      }

      const intent = await fetchIntent(body);
      setGoal(intent);
      setCheck(null);
      setSkipped(new Set());
      setTranscript(`Goal: ${intent.goal}`);
      speak(`Got it. For ${intent.goal}, let me check what you have.`);
      log('Intent:', intent);
    } catch (err) {
      setTranscript('Error: ' + err.message);
      log('Intent error:', err.message);
    }
  }

  // ---------------------------------------------------------------------
  // Scan fridge/cupboard
  // ---------------------------------------------------------------------
  async function scan() {
    if (!goal) return;
    setScanning(true);
    try {
      const result = await visionCheck(captureFrame(), goal.ingredients);
      log('Vision check:', result);
      setCheck(result);
      setSkipped(new Set());
      const n = result.missing.length;
      speak(
        n === 0
          ? "Good news, you've got everything."
          : `You're missing ${n} thing${n > 1 ? 's' : ''}: ${result.missing.join(', ')}.`
      );
    } catch (err) {
      log('Vision error:', err.message);
      alert('Vision check failed: ' + err.message);
    } finally {
      setScanning(false);
    }
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
        <video ref={videoRef} autoPlay playsInline muted />
        <div className="camera-controls">
          <button onClick={startCamera} disabled={cameraOn}>
            {cameraOn ? 'Camera on' : 'Start camera'}
          </button>
          <label className="toggle">
            <input
              type="checkbox"
              checked={useOmniAudio}
              onChange={(e) => setUseOmniAudio(e.target.checked)}
            />
            Send raw audio to OMNI (uncheck to use browser transcript instead)
          </label>
        </div>
      </section>

      <section className="control-panel">
        <button
          className={`talk-btn${recording ? ' recording' : ''}`}
          disabled={!cameraOn}
          onPointerDown={onTalkDown}
          onPointerUp={onTalkUp}
          onPointerCancel={onTalkUp}
        >
          {recording ? 'Recording... release to send' : 'Hold to talk'}
        </button>
        <div className="pill">{transcript}</div>

        {goal && (
          <div className="block">
            <h2>Goal</h2>
            <div className="pill">{goal.goal}</div>
            <h3>Needed</h3>
            <ul className="list">
              {goal.ingredients.map((ing) => (
                <li key={ing.name}>
                  {ing.name}
                  {ing.quantity ? ` (${ing.quantity} ${ing.unit || ''})` : ''}
                </li>
              ))}
            </ul>
            <button className="wide" onClick={scan} disabled={scanning || !cameraOn}>
              {scanning ? 'Scanning...' : 'Scan fridge / cupboard'}
            </button>
          </div>
        )}

        {check && (
          <div className="block">
            <h2>Inventory check</h2>
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
            <p className="hint">Click an item to skip buying it.</p>
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
