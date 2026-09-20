import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, LayoutGroup, motion, useMotionValue } from 'motion/react';
import {
  CheckCircle,
  CircleNotch,
  Cpu,
  Eye,
  ForkKnife,
  Microphone,
  MinusCircle,
  PaperPlaneTilt,
  Play,
  ShoppingCartSimple,
  Stop,
  VideoCamera,
  X,
  XCircle,
} from '@phosphor-icons/react';
import { createMicSegmenter } from '../audio.js';
import { fetchIntent, fetchOakStatus, fetchPrices, purchaseItems, visionCheck } from '../api.js';
import LevelMeter from '../components/LevelMeter.jsx';
import { Button, Chip, Field, Panel, Segmented, Switch, cx, inputClass } from '../components/ui.jsx';

const SCAN_INTERVAL_MS = 3000; // one camera frame to OMNI every few seconds
const FLIP_CONFIRMATIONS = 2; // a status must hold for this many scans before it changes

const PHASE_LABEL = {
  idle: 'Camera off',
  listening: 'Ready',
  hearing: 'Hearing you',
  thinking: 'Thinking',
  speaking: 'Speaking',
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

// Everything that differs between the two modes. The backend gets `mode` and
// swaps its prompts and Zip vendor; this is the matching copy for the page.
const MODES = {
  food: {
    title: 'Live shelf',
    where: 'shelf',
    verb: 'Making',
    prompt: 'What are you making?',
    intro: 'Say it out loud or tap an example. OMNI works out the shopping list, then checks it against your shelf.',
    offHint: 'Start it and OMNI will watch the shelf and listen for what you want to make.',
    chatHint: 'Try “I’m baking a chocolate cake”, then “skip the sugar”.',
    placeholder: "I'm making pancakes",
    haveLabel: 'On the shelf',
    examples: ["I'm baking a chocolate cake", "I'm making pancakes", 'I need ingredients for tacos'],
  },
  hardware: {
    title: 'Live workbench',
    where: 'desk',
    verb: 'Building',
    prompt: 'What are you building?',
    intro: 'Say it out loud or tap an example. OMNI works out the parts list, then checks it against your desk.',
    offHint: 'Start it and OMNI will watch your desk and listen for what you want to build.',
    chatHint: 'Try “I want a Wi-Fi camera that streams to my server”, then “skip the microSD”.',
    placeholder: 'A Wi-Fi camera that streams to a server',
    haveLabel: 'On the desk',
    examples: [
      'I want a smart plant monitor that texts me when the soil is dry',
      'I want to build a weather station that logs to the cloud',
      'I need parts for a tiny rover that avoids obstacles',
    ],
  },
};

const MODE_OPTIONS = [
  { id: 'food', label: 'Food', icon: ForkKnife },
  { id: 'hardware', label: 'Hardware', icon: Cpu },
];

const ROW_ICON = {
  have: <CheckCircle size={20} weight="regular" className="shrink-0 text-ok" aria-hidden />,
  buy: <XCircle size={20} weight="regular" className="shrink-0 text-accent-ink" aria-hidden />,
  skipped: <MinusCircle size={20} weight="regular" className="shrink-0 text-muted" aria-hidden />,
  checking: (
    <CircleNotch
      size={20}
      weight="regular"
      className="shrink-0 animate-spin text-muted motion-reduce:animate-none"
      aria-hidden
    />
  ),
};

// One ingredient. layoutId lets a row glide from "To buy" to "On the shelf"
// the moment the camera spots it, which is the whole point of the live scan.
// `price` is the quote from /api/prices: { product, rate }.
function IngredientRow({ name, qty, state, price, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  const dimmed = state === 'skipped';
  return (
    <motion.li
      layout
      layoutId={`ing-${name}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
    >
      <Tag
        {...(onClick ? { type: 'button', onClick, 'aria-pressed': dimmed } : {})}
        className={cx(
          'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[15px] transition-colors duration-200',
          onClick && 'hover:bg-surface-2'
        )}
      >
        {ROW_ICON[state]}
        <span className="min-w-0 flex-1">
          <span className={cx('block truncate', dimmed && 'text-muted line-through')}>{name}</span>
          {price?.product && price.product.toLowerCase() !== name.toLowerCase() && (
            <span className="block truncate text-xs text-muted">{price.product}</span>
          )}
        </span>
        <span className="shrink-0 text-right">
          {price?.rate && (
            <span className={cx('block font-mono text-sm', dimmed ? 'text-muted line-through' : 'text-fg')}>
              ${price.rate}
            </span>
          )}
          <span className="block font-mono text-xs text-muted">{dimmed ? 'Skipped' : qty}</span>
        </span>
      </Tag>
    </motion.li>
  );
}

const money = (n) => `$${n.toFixed(2)}`;

function TypingDots() {
  return (
    <div className="flex w-fit gap-1 rounded-2xl bg-surface-2 px-4 py-3" aria-label="OMNI is thinking">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-muted"
          animate={{ y: [0, -4, 0] }}
          transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.12, ease: 'easeInOut' }}
        />
      ))}
    </div>
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
  const pendingPricesRef = useRef(0); // price requests in flight
  const statusRef = useRef(new Map()); // ingredient -> { status, pending, count } (debounced)

  const [cameraOn, setCameraOn] = useState(false);
  const [oak, setOak] = useState(null); // /api/oak/status, or null while loading
  const [source, setSource] = useState('computer'); // 'computer' | 'oak'
  const [mode, setMode] = useState('food'); // 'food' | 'hardware'
  const [liveScan, setLiveScan] = useState(true);
  const [phase, setPhase] = useState('idle');
  const levelMV = useMotionValue(0); // mic level, read by the meter without re-rendering
  const [scanning, setScanning] = useState(false);
  const [notice, setNotice] = useState(null);
  const [holding, setHolding] = useState(false);
  const [messages, setMessages] = useState([]); // { role: 'user' | 'omni' | 'error', text }
  const [typed, setTyped] = useState('');
  const [goal, setGoal] = useState(null); // { goal, ingredients }
  const [check, setCheck] = useState(null); // { present: [], missing: [] }
  const [visible, setVisible] = useState([]); // everything OMNI currently sees
  const [skipped, setSkipped] = useState(() => new Set());
  const [prices, setPrices] = useState({}); // item name -> { product, rate } from OMNI
  const [pricing, setPricing] = useState(false);
  const [purchasing, setPurchasing] = useState(false);
  const [logLines, setLogLines] = useState([]);

  // Latest state for callbacks created once (mic loop, scan interval).
  const live = useRef({});
  live.current = { mode, source, cameraOn, liveScan, goal, check, visible, skipped, prices };

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
        onLevel: (v) => levelMV.set(v),
      });
      setCameraOn(true);
      setPhase('listening');
      setNotice(null);
      log(`Camera and mic started (${useOak ? 'OAK camera' : 'computer camera'}).`);
    } catch (err) {
      log('Start error:', err.message);
      setNotice('Could not access the camera or microphone: ' + err.message);
    }
  }

  function stop() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    segmenterRef.current?.stop();
    segmenterRef.current = null;
    if (oakImgRef.current) oakImgRef.current.src = ''; // closes the stream; backend then frees the USB device
    if (videoRef.current) videoRef.current.srcObject = null;
    stopSpeaking();
    levelMV.set(0);
    setHolding(false);
    setCameraOn(false);
    setPhase('idle');
    log('Camera and mic stopped.');
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
    setScanning(true);
    const goalAtStart = live.current.goal;
    const modeAtStart = live.current.mode;
    const ingredients = goalAtStart?.ingredients ?? [];
    try {
      const result = await visionCheck(frame, ingredients, modeAtStart);
      if (live.current.mode !== modeAtStart) return; // mode switched mid-scan: this frame is stale
      setVisible(result.visible);
      // The goal changed while this frame was being analysed: its checklist is stale.
      if (ingredients.length && live.current.goal === goalAtStart) applyScan(ingredients, result);
    } catch (err) {
      log('Scan error:', err.message);
    } finally {
      scanBusyRef.current = false;
      setScanning(false);
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
      mode: s.mode,
    };

    try {
      const r = await fetchIntent(body);
      if (live.current.mode !== body.mode) return; // mode switched while OMNI was thinking
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
      setPrices({});
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
      setNotice('Nothing left to order. Tap a skipped item to add it back.');
      return;
    }
    setPurchasing(true);
    try {
      const items = toBuy.map((name) => {
        const match = goal.ingredients.find((i) => i.name === name);
        return { name, quantity: match?.quantity || 1, unit: match?.unit || 'unit' };
      });
      // Send the quotes on screen so Zip is billed the amounts the user approved.
      const quotes = Object.fromEntries(toBuy.filter((n) => prices[n]).map((n) => [n, prices[n]]));
      const { results, unavailable } = await purchaseItems(items, goal.goal, mode, quotes);
      log('Purchase results:', results);

      // Hardware checkout checks the lab's stock: if anything is short, nothing was sent.
      if (unavailable?.length) {
        const text =
          `I can't send this order yet. ${unavailable.map((u) => u.reason).join('. ')}. ` +
          'Nothing was sent to Zip. Skip those items or change the plan, then check out again.';
        say('omni', text);
        speak(text);
        setNotice(text);
        setPurchasing(false);
        return;
      }

      if (mode === 'hardware') {
        const failed = results.filter((r) => r.status === 'error').length;
        const sent = results.length - failed;
        const text = failed
          ? `${sent} request${sent === 1 ? '' : 's'} sent to Zip, ${failed} failed.`
          : `Success! ${sent} request${sent === 1 ? '' : 's'} sent to Zip.`;
        say('omni', text);
        speak(text);
      } else {
        const approved = results.filter((r) => r.status === 'approved').length;
        const pending = results.filter((r) =>
          ['pending', 'submitted', 'awaiting approval'].includes(r.status)
        ).length;
        speak(
          `Submitted ${results.length} purchase${results.length > 1 ? 's' : ''} to Zip. ` +
            `${approved} approved, ${pending} pending approval.`
        );
      }
      navigate('/purchases');
    } catch (err) {
      log('Purchase error:', err.message);
      setNotice('The order failed: ' + err.message);
      setPurchasing(false);
    }
  }

  // A different mode is a different checklist and conversation: start fresh.
  function switchMode(next) {
    if (next === mode) return;
    stopSpeaking();
    live.current.mode = next; // in-flight scans and replies see it immediately and drop themselves
    live.current.goal = null;
    statusRef.current = new Map();
    announceFirstScanRef.current = false;
    setMode(next);
    setGoal(null);
    setCheck(null);
    setVisible([]);
    setSkipped(new Set());
    setPrices({});
    setMessages([]);
    setNotice(null);
  }

  const copy = MODES[mode];
  const sourceLabel = source === 'oak' ? 'OAK camera' : 'Computer camera';
  const needed = goal?.ingredients ?? [];
  const haveNames = check?.present ?? [];
  const missingNames = check?.missing ?? [];
  const toBuy = missingNames.filter((n) => !skipped.has(n));
  const qtyOf = (name) => {
    const i = needed.find((x) => x.name === name);
    return i?.quantity ? `${i.quantity} ${i.unit || ''}`.trim() : '';
  };
  const quoted = toBuy.filter((n) => prices[n]?.rate);
  const total = quoted.reduce((sum, n) => sum + Number(prices[n].rate), 0);

  // Quote anything newly missing, so the basket shows prices before ordering.
  // Prices already held are kept: an item that flickers missing doesn't re-ask.
  useEffect(() => {
    const want = missingNames.filter((n) => !live.current.prices[n]);
    if (want.length === 0) return undefined;
    const goalAtStart = goal;
    const modeAtStart = mode;
    let cancelled = false;
    pendingPricesRef.current += 1;
    setPricing(true);
    fetchPrices(
      want.map((name) => needed.find((i) => i.name === name) ?? { name }),
      goal?.goal ?? null,
      modeAtStart
    )
      .then((r) => {
        // A new goal or mode while OMNI was pricing makes these quotes stale.
        if (cancelled || live.current.goal !== goalAtStart || live.current.mode !== modeAtStart) return;
        setPrices((prev) => ({ ...prev, ...r.prices }));
      })
      .catch((err) => log('Price error:', err.message))
      .finally(() => {
        pendingPricesRef.current -= 1;
        if (pendingPricesRef.current === 0) setPricing(false);
      });
    return () => {
      cancelled = true;
    };
    // Prices are read through live.current so holding one doesn't re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingNames.join('|'), mode]);

  const chatRef = useRef(null);
  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, phase]);

  return (
    <motion.main
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="mx-auto w-full max-w-[1400px] px-4 pt-8 pb-16 md:px-6"
    >
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        {/* Left: the camera stage, with the voice dock floating over its bottom edge */}
        <section aria-label="Camera" className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{copy.title}</h1>
            <Segmented label="Mode" value={mode} onChange={switchMode} options={MODE_OPTIONS} />
          </div>
          <p className="mb-4 flex items-center gap-2 text-sm text-muted">
            {cameraOn ? (
              <>
                <span className="h-2 w-2 rounded-full bg-ok" aria-hidden />
                {sourceLabel}
                {liveScan ? (scanning ? ', scanning' : `, scans every ${SCAN_INTERVAL_MS / 1000}s`) : ''}
              </>
            ) : (
              'Camera off'
            )}
          </p>

          <div className="relative aspect-video overflow-hidden rounded-panel border border-line bg-surface-2">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              hidden={source === 'oak' || !cameraOn}
              className="h-full w-full object-cover"
            />
            <img
              ref={oakImgRef}
              alt="Live view from the OAK camera"
              hidden={source !== 'oak' || !cameraOn}
              className="h-full w-full object-cover"
            />
            {!cameraOn && (
              <div className="absolute inset-0 grid place-content-center justify-items-center gap-3 px-6 text-center">
                <VideoCamera size={40} weight="regular" className="text-muted" aria-hidden />
                <p className="text-lg font-medium tracking-tight">The camera is off</p>
                <p className="max-w-[42ch] text-sm text-muted">
                  {copy.offHint}
                </p>
              </div>
            )}
            {cameraOn && scanning && <div className="scan-line pointer-events-none absolute inset-0" aria-hidden />}
          </div>

          <div className="glass relative z-10 mx-3 -mt-7 rounded-panel p-3 md:mx-8 md:p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3 pl-1">
                <LevelMeter level={levelMV} active={phase === 'hearing'} />
                <div className="relative h-5 min-w-[7rem] overflow-hidden text-sm font-medium">
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={phase}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.18 }}
                      className="absolute inset-0"
                    >
                      {PHASE_LABEL[phase]}
                    </motion.span>
                  </AnimatePresence>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant={holding ? 'inverse' : 'secondary'}
                  icon={Microphone}
                  disabled={!cameraOn}
                  onPointerDown={talkDown}
                  onPointerUp={talkUp}
                  onPointerCancel={talkUp}
                  className="touch-none select-none"
                >
                  {holding ? 'Release to send' : 'Hold to talk'}
                </Button>
                {cameraOn ? (
                  <Button variant="ghost" icon={Stop} onClick={stop}>
                    Stop
                  </Button>
                ) : (
                  <Button icon={Play} onClick={start}>
                    Start camera
                  </Button>
                )}
              </div>
            </div>
          </div>

          <AnimatePresence>
            {notice && (
              <motion.div
                role="alert"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="mt-4 flex items-start justify-between gap-3 rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
              >
                <span>{notice}</span>
                <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="shrink-0">
                  <X size={16} weight="regular" aria-hidden />
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <Field label="Camera">
              <select
                value={source}
                onChange={(e) => setSource(e.target.value)}
                disabled={cameraOn}
                className={inputClass}
              >
                <option value="computer">Computer camera</option>
                <option value="oak" disabled={!oak?.available}>
                  {oak?.available ? 'OAK camera (Luxonis)' : 'OAK camera (not detected)'}
                </option>
              </select>
            </Field>
            <Switch
              checked={liveScan}
              onChange={setLiveScan}
              label="Scan continuously"
              hint={`A frame every ${SCAN_INTERVAL_MS / 1000}s`}
            />
          </div>

          <div className="mt-8">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-muted">
              <Eye size={18} weight="regular" aria-hidden />
              In view
            </h2>
            <ul className="flex min-h-8 flex-wrap gap-2">
              <AnimatePresence initial={false}>
                {visible.map((v) => (
                  <motion.li
                    key={v}
                    layout
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                  >
                    <Chip>{v}</Chip>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
            {visible.length === 0 && (
              <p className="text-sm text-muted">
                {cameraOn ? 'Nothing recognised yet.' : 'Start the camera and OMNI will list what it sees.'}
              </p>
            )}
          </div>
        </section>

        {/* Right: conversation, then the shopping list */}
        <section aria-label="Assistant" className="flex min-w-0 flex-col gap-6">
          <Panel className="flex flex-col p-5">
            <h2 className="text-sm font-medium text-muted">Conversation</h2>
            <div ref={chatRef} className="mt-4 flex max-h-72 min-h-40 flex-col gap-2 overflow-y-auto pr-1">
              {messages.length === 0 && (
                <p className="my-auto text-sm text-muted">
                  {copy.chatHint}
                </p>
              )}
              <AnimatePresence initial={false}>
                {messages.map((m, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                    className={cx(
                      'max-w-[88%] rounded-2xl px-4 py-2.5 text-[15px] leading-snug',
                      m.role === 'user' && 'self-end bg-accent/15',
                      m.role === 'omni' && 'self-start bg-surface-2',
                      m.role === 'error' && 'self-start border border-danger/30 text-danger'
                    )}
                  >
                    {m.text}
                  </motion.div>
                ))}
              </AnimatePresence>
              {phase === 'thinking' && <TypingDots />}
            </div>
            <form onSubmit={submitTyped} className="mt-4 flex items-end gap-2">
              <div className="flex-1">
                <Field label="Type instead">
                  <input
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder={copy.placeholder}
                    className={inputClass}
                  />
                </Field>
              </div>
              <Button
                type="submit"
                variant="secondary"
                icon={PaperPlaneTilt}
                disabled={!typed.trim()}
                aria-label="Send"
                className="w-11 px-0"
              />
            </form>
          </Panel>

          {!goal ? (
            <Panel className="p-5">
              <h2 className="text-xl font-semibold tracking-tight">{copy.prompt}</h2>
              <p className="mt-1 max-w-[46ch] text-sm text-muted">{copy.intro}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {copy.examples.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => {
                      stopSpeaking();
                      enqueue(() => sendIntent({ transcript: ex }));
                    }}
                    className="h-9 rounded-full border border-line bg-surface-2 px-4 text-sm transition duration-200 hover:border-accent hover:text-accent-ink active:scale-[0.98]"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </Panel>
          ) : (
            <Panel className="p-5">
              <p className="text-sm text-muted">{copy.verb}</p>
              <h2 className="text-3xl font-semibold capitalize tracking-tight md:text-4xl">{goal.goal}</h2>
              <p className="mt-2 font-mono text-sm text-muted">
                {check ? `${haveNames.length} of ${needed.length} on the ${copy.where}` : `Checking the ${copy.where}`}
              </p>

              <LayoutGroup>
                {!check && (
                  <ul className="mt-5 flex flex-col">
                    {needed.map((i) => (
                      <IngredientRow key={i.name} name={i.name} qty={qtyOf(i.name)} state="checking" />
                    ))}
                  </ul>
                )}
                {check && haveNames.length > 0 && (
                  <div className="mt-5">
                    <h3 className="px-3 text-sm font-medium text-muted">{copy.haveLabel}</h3>
                    <ul className="mt-1 flex flex-col">
                      {haveNames.map((n) => (
                        <IngredientRow key={n} name={n} qty={qtyOf(n)} state="have" />
                      ))}
                    </ul>
                  </div>
                )}
                {check && missingNames.length > 0 && (
                  <div className="mt-5">
                    <h3 className="px-3 text-sm font-medium text-muted">To buy</h3>
                    <ul className="mt-1 flex flex-col">
                      {missingNames.map((n) => (
                        <IngredientRow
                          key={n}
                          name={n}
                          qty={qtyOf(n)}
                          price={prices[n]}
                          state={skipped.has(n) ? 'skipped' : 'buy'}
                          onClick={() => toggleSkip(n)}
                        />
                      ))}
                    </ul>
                    <p className="mt-2 px-3 text-xs text-muted">
                      Tap an item, or say “skip” and its name.
                      {pricing
                        ? ' Pricing…'
                        : quoted.length > 0 &&
                          (mode === 'hardware'
                            ? ' Parts are borrowed from the MLH lab, so there is no cost.'
                            : ' Prices are OMNI estimates of the pack Zip will order.')}
                    </p>
                  </div>
                )}
              </LayoutGroup>

              {check && missingNames.length === 0 && (
                <p className="mt-5 flex items-center gap-2 text-[15px]">
                  <CheckCircle size={20} weight="regular" className="text-ok" aria-hidden />
                  You have everything you need.
                </p>
              )}

              {check && missingNames.length > 0 && (
                <div className="mt-6 flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm text-muted">
                      <span className="font-mono text-fg">{toBuy.length}</span> to order
                      {skipped.size > 0 && (
                        <>
                          , <span className="font-mono text-fg">{skipped.size}</span> skipped
                        </>
                      )}
                    </p>
                    {quoted.length > 0 && (
                      <p className="mt-1 text-sm text-muted">
                        <span className="font-mono text-lg text-fg">{money(total)}</span>{' '}
                        {quoted.length < toBuy.length ? `for ${quoted.length} of ${toBuy.length}` : 'estimated total'}
                      </p>
                    )}
                  </div>
                  <Button icon={ShoppingCartSimple} onClick={purchase} disabled={purchasing || toBuy.length === 0}>
                    {purchasing ? 'Ordering' : 'Order with Zip'}
                  </Button>
                </div>
              )}
            </Panel>
          )}
        </section>
      </div>

      <details className="mt-12 text-sm text-muted">
        <summary className="w-fit cursor-pointer select-none">Debug log</summary>
        <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-2xl border border-line bg-surface p-4 font-mono text-xs">
          {logLines.join('\n')}
        </pre>
      </details>
    </motion.main>
  );
}
