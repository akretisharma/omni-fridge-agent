// app.js
// Frontend orchestration: webcam, push-to-talk mic, and the three backend
// calls (/api/intent, /api/vision-check, /api/purchase). No API keys live
// here - everything sensitive stays on the server.

const el = (id) => document.getElementById(id);
const video = el('video');
const canvas = el('canvas');
const talkBtn = el('talkBtn');
const transcriptEl = el('transcript');
const logEl = el('log');

let currentGoal = null; // { goal, ingredients }
let currentMissing = []; // items still to purchase (post skip)
let mediaRecorder = null;
let audioChunks = [];

function log(msg, obj) {
  const line = obj ? `${msg} ${JSON.stringify(obj)}` : msg;
  logEl.textContent = `${line}\n${logEl.textContent}`.slice(0, 8000);
  console.log(msg, obj || '');
}

function speak(text) {
  // Browser TTS for narration - reliable and zero extra API calls. Swap for
  // OMNI's own voice output if/when you want the "adaptive voice/tone"
  // criterion to run through OMNI end-to-end instead.
  try {
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.05;
    speechSynthesis.speak(utter);
  } catch (e) {
    /* speech synthesis not available - non-fatal */
  }
}

// ---------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------
el('startCamera').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    video.srcObject = stream;
    talkBtn.disabled = false;
    log('Camera started.');
  } catch (err) {
    log('Camera error:', err.message);
    alert('Could not access camera: ' + err.message);
  }
});

function captureFrame() {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.85); // data:image/jpeg;base64,...
}

// ---------------------------------------------------------------------
// Push-to-talk: hold the button to record audio for OMNI
// ---------------------------------------------------------------------
async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioChunks = [];
  mediaRecorder = new MediaRecorder(stream);
  mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
  mediaRecorder.start();
  talkBtn.classList.add('recording');
  talkBtn.textContent = 'Recording... release to send';
}

function stopRecording() {
  return new Promise((resolve) => {
    if (!mediaRecorder) return resolve(null);
    mediaRecorder.onstop = () => {
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      mediaRecorder.stream.getTracks().forEach((t) => t.stop());
      resolve(blob);
    };
    mediaRecorder.stop();
  });
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
// unchecked. Handy as a demo safety net if live audio upload to OMNI is
// flaky on venue wifi.
function transcribeWithBrowser() {
  return new Promise((resolve, reject) => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return reject(new Error('SpeechRecognition not supported in this browser'));
    const rec = new SpeechRecognition();
    rec.lang = 'en-US';
    rec.onresult = (e) => resolve(e.results[0][0].transcript);
    rec.onerror = (e) => reject(new Error(e.error));
    rec.start();
  });
}

talkBtn.addEventListener('mousedown', async () => {
  try {
    await startRecording();
  } catch (err) {
    log('Mic error:', err.message);
    alert('Could not access microphone: ' + err.message);
  }
});

talkBtn.addEventListener('mouseup', async () => {
  if (!mediaRecorder) return;
  talkBtn.classList.remove('recording');
  talkBtn.textContent = 'Hold to talk';
  const blob = await stopRecording();
  await handleUtterance(blob);
});

async function handleUtterance(audioBlob) {
  transcriptEl.textContent = 'Thinking...';
  const useOmniAudio = el('useOmniAudio').checked;

  try {
    let body;
    if (useOmniAudio && audioBlob) {
      const audioBase64 = await blobToBase64(audioBlob);
      body = { audioBase64, audioFormat: 'webm' };
    } else {
      const transcript = await transcribeWithBrowser();
      body = { transcript };
    }

    const res = await fetch('/api/intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    const intent = await res.json();

    currentGoal = intent;
    transcriptEl.textContent = `Goal: ${intent.goal}`;
    renderGoal(intent);
    speak(`Got it. For ${intent.goal}, let me check what you have.`);
    log('Intent:', intent);
  } catch (err) {
    transcriptEl.textContent = 'Error: ' + err.message;
    log('Intent error:', err.message);
  }
}

function renderGoal(intent) {
  el('goalBlock').classList.remove('hidden');
  el('goalText').textContent = intent.goal;
  const ul = el('neededList');
  ul.innerHTML = '';
  intent.ingredients.forEach((ing) => {
    const li = document.createElement('li');
    li.textContent = `${ing.name}${ing.quantity ? ` (${ing.quantity} ${ing.unit || ''})` : ''}`;
    ul.appendChild(li);
  });
  el('checkBlock').classList.add('hidden');
  el('purchaseBlock').classList.add('hidden');
}

// ---------------------------------------------------------------------
// Scan fridge/cupboard
// ---------------------------------------------------------------------
el('scanBtn').addEventListener('click', async () => {
  if (!currentGoal) return;
  el('scanBtn').disabled = true;
  el('scanBtn').textContent = 'Scanning...';

  try {
    const imageBase64 = captureFrame();
    const res = await fetch('/api/vision-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64, ingredients: currentGoal.ingredients }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    const result = await res.json();
    log('Vision check:', result);
    renderCheck(result);

    const missingCount = result.missing.length;
    speak(
      missingCount === 0
        ? "Good news, you've got everything."
        : `You're missing ${missingCount} thing${missingCount > 1 ? 's' : ''}: ${result.missing.join(', ')}.`
    );
  } catch (err) {
    log('Vision error:', err.message);
    alert('Vision check failed: ' + err.message);
  } finally {
    el('scanBtn').disabled = false;
    el('scanBtn').textContent = 'Scan fridge / cupboard';
  }
});

function renderCheck(result) {
  el('checkBlock').classList.remove('hidden');

  const presentUl = el('presentList');
  presentUl.innerHTML = '';
  result.present.forEach((name) => {
    const li = document.createElement('li');
    li.textContent = name;
    presentUl.appendChild(li);
  });

  currentMissing = [...result.missing];
  const missingUl = el('missingList');
  missingUl.innerHTML = '';
  result.missing.forEach((name) => {
    const li = document.createElement('li');
    li.textContent = name;
    li.dataset.name = name;
    li.addEventListener('click', () => {
      li.classList.toggle('skipped');
      if (li.classList.contains('skipped')) {
        currentMissing = currentMissing.filter((n) => n !== name);
      } else {
        currentMissing.push(name);
      }
    });
    missingUl.appendChild(li);
  });

  el('purchaseBlock').classList.add('hidden');
}

// ---------------------------------------------------------------------
// Purchase via Zip
// ---------------------------------------------------------------------
el('purchaseBtn').addEventListener('click', async () => {
  if (currentMissing.length === 0) {
    alert('Nothing left to purchase.');
    return;
  }
  el('purchaseBtn').disabled = true;
  el('purchaseBtn').textContent = 'Submitting to Zip...';

  try {
    const items = currentMissing.map((name) => {
      const match = currentGoal.ingredients.find((i) => i.name === name);
      return {
        name,
        quantity: match?.quantity || 1,
        unit: match?.unit || 'unit',
      };
    });

    const res = await fetch('/api/purchase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, goal: currentGoal.goal }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    const { results } = await res.json();
    log('Purchase results:', results);
    renderPurchase(results);

    const approved = results.filter((r) => r.status === 'approved').length;
    const pending = results.filter((r) => r.status === 'pending' || r.status === 'submitted').length;
    speak(`Submitted ${results.length} purchase${results.length > 1 ? 's' : ''} to Zip. ${approved} approved, ${pending} pending approval.`);
  } catch (err) {
    log('Purchase error:', err.message);
    alert('Purchase failed: ' + err.message);
  } finally {
    el('purchaseBtn').disabled = false;
    el('purchaseBtn').textContent = 'Purchase missing items via Zip';
  }
});

function renderPurchase(results) {
  el('purchaseBlock').classList.remove('hidden');
  const ul = el('purchaseList');
  ul.innerHTML = '';
  results.forEach((r) => {
    const li = document.createElement('li');
    li.textContent = `${r.name}: ${r.status}${r.error ? ` (${r.error})` : ''}`;
    ul.appendChild(li);
  });
}
