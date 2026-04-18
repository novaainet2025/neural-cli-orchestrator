/* dashboard/app.js — MediaPipe Hands 손바닥 인식 대시보드 */
(() => {
  // ---------- DOM ----------
  const camBtn = document.getElementById('cam-toggle');
  const cam1Select = document.getElementById('cam1-select');
  const cam2Select = document.getElementById('cam2-select');
  const video1 = document.getElementById('video1');
  const video2 = document.getElementById('video2');
  const canvas1 = document.getElementById('canvas1');
  const canvas2 = document.getElementById('canvas2');
  const ctx1 = canvas1.getContext('2d');
  const ctx2 = canvas2.getContext('2d');
  const indicator1 = document.getElementById('indicator1');
  const indicator2 = document.getElementById('indicator2');
  const eventLog = document.getElementById('event-log');
  const enterCountEl = document.getElementById('enter-count');
  const exitCountEl = document.getElementById('exit-count');
  const fpsEl = document.getElementById('fps-display');
  const modelStatusEl = document.getElementById('model-status').querySelector('.status');

  let isRunning = false;
  let enterCount = 0;
  let exitCount = 0;
  let hands1 = null;
  let hands2 = null;
  let camera1 = null;
  let camera2 = null;
  let lastFpsTime = performance.now();
  let frameCount = 0;

  // 쿨다운: 같은 카메라에서 연속 감지 방지 (2초)
  const COOLDOWN_MS = 2000;
  let lastDetect1 = 0;
  let lastDetect2 = 0;

  // ---------- 카메라 목록 ----------
  async function populateCameras() {
    try {
      // 권한 요청을 위해 임시 스트림
      const tempStream = await navigator.mediaDevices.getUserMedia({ video: true });
      tempStream.getTracks().forEach(t => t.stop());

      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(d => d.kind === 'videoinput');

      [cam1Select, cam2Select].forEach((sel, idx) => {
        // 기본 옵션 유지
        videoDevices.forEach((dev, i) => {
          const opt = document.createElement('option');
          opt.value = dev.deviceId;
          opt.textContent = dev.label || `카메라 ${i + 1}`;
          sel.appendChild(opt);
        });
        // 자동 선택: 첫 번째/두 번째 카메라
        if (videoDevices[idx]) {
          sel.value = videoDevices[idx].deviceId;
        } else if (videoDevices[0]) {
          sel.value = videoDevices[0].deviceId;
        }
      });
    } catch (err) {
      console.error('카메라 열거 실패:', err);
    }
  }

  // ---------- MediaPipe Hands 초기화 ----------
  function createHands(onResults) {
    const hands = new Hands({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`,
    });
    hands.setOptions({
      maxNumHands: 2,
      modelComplexity: 1,
      minDetectionConfidence: 0.7,
      minTrackingConfidence: 0.5,
    });
    hands.onResults(onResults);
    return hands;
  }

  // ---------- 손바닥 펼침 판정 ----------
  function isOpenPalm(landmarks) {
    // 랜드마크 인덱스: 손목=0, 엄지끝=4, 검지끝=8, 중지끝=12, 약지끝=16, 소지끝=20
    // 각 손가락 끝이 MCP(관절) 위에 있으면 펼친 것으로 판정
    const tipIds = [8, 12, 16, 20];
    const mcpIds = [5, 9, 13, 17];
    let extended = 0;

    for (let i = 0; i < tipIds.length; i++) {
      // y가 작을수록 위쪽 (화면 좌표)
      if (landmarks[tipIds[i]].y < landmarks[mcpIds[i]].y) {
        extended++;
      }
    }

    // 엄지: tip이 IP(관절)보다 x축으로 바깥
    const thumbTip = landmarks[4];
    const thumbIp = landmarks[3];
    const wrist = landmarks[0];
    // 왼손/오른손 판별: 손목 기준 엄지 방향
    const isRightHand = landmarks[17].x < landmarks[5].x;
    if (isRightHand) {
      if (thumbTip.x < thumbIp.x) extended++;
    } else {
      if (thumbTip.x > thumbIp.x) extended++;
    }

    return extended >= 4; // 4개 이상 펼침 → 손바닥
  }

  // ---------- 결과 핸들러 ----------
  function handleResults(cameraId, video, canvas, canvasCtx, indicator) {
    return (results) => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return;

      canvas.width = w;
      canvas.height = h;
      canvasCtx.clearRect(0, 0, w, h);

      let palmDetected = false;

      if (results.multiHandLandmarks) {
        for (const landmarks of results.multiHandLandmarks) {
          // 랜드마크 그리기
          drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, {
            color: '#00FF00', lineWidth: 2,
          });
          drawLandmarks(canvasCtx, landmarks, {
            color: '#FF0000', lineWidth: 1, radius: 3,
          });

          if (isOpenPalm(landmarks)) {
            palmDetected = true;
          }
        }
      }

      const now = Date.now();
      if (palmDetected) {
        indicator.classList.add('active');
        if (cameraId === 1 && now - lastDetect1 > COOLDOWN_MS) {
          lastDetect1 = now;
          enterCount++;
          enterCountEl.textContent = enterCount;
          addEvent('입실', `Camera1 — 손바닥 감지 (#${enterCount})`);
        } else if (cameraId === 2 && now - lastDetect2 > COOLDOWN_MS) {
          lastDetect2 = now;
          exitCount++;
          exitCountEl.textContent = exitCount;
          addEvent('퇴실', `Camera2 — 손바닥 감지 (#${exitCount})`);
        }
      } else {
        indicator.classList.remove('active');
      }

      // FPS 계산
      frameCount++;
      if (now - lastFpsTime >= 1000) {
        fpsEl.textContent = `FPS: ${frameCount}`;
        frameCount = 0;
        lastFpsTime = now;
      }
    };
  }

  // ---------- 이벤트 로그 ----------
  function addEvent(type, message) {
    // 플레이스홀더 제거
    const placeholder = eventLog.querySelector('.event-placeholder');
    if (placeholder) placeholder.remove();

    const row = document.createElement('div');
    row.className = `event-row event-${type === '입실' ? 'enter' : 'exit'}`;

    const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    row.innerHTML = `
      <span class="event-time">${time}</span>
      <span class="event-type">${type}</span>
      <span class="event-msg">${message}</span>
    `;
    eventLog.appendChild(row);
    eventLog.scrollTop = eventLog.scrollHeight;

    // 최대 200개 유지
    while (eventLog.children.length > 200) {
      eventLog.removeChild(eventLog.firstChild);
    }
  }

  // ---------- 카메라 시작/중지 ----------
  async function startCameras() {
    const deviceId1 = cam1Select.value;
    const deviceId2 = cam2Select.value;

    if (!deviceId1 && !deviceId2) {
      alert('카메라를 하나 이상 선택해주세요.');
      return;
    }

    // Hands 인스턴스 생성
    hands1 = createHands(handleResults(1, video1, canvas1, ctx1, indicator1));
    hands2 = createHands(handleResults(2, video2, canvas2, ctx2, indicator2));

    modelStatusEl.textContent = '로딩 중…';
    modelStatusEl.className = 'status offline';

    // Camera 1
    if (deviceId1) {
      const stream1 = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId1 }, width: 640, height: 480 },
      });
      video1.srcObject = stream1;
      camera1 = new Camera(video1, {
        onFrame: async () => { await hands1.send({ image: video1 }); },
        width: 640,
        height: 480,
      });
      camera1.start();
    }

    // Camera 2
    if (deviceId2) {
      const stream2 = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId2 }, width: 640, height: 480 },
      });
      video2.srcObject = stream2;
      camera2 = new Camera(video2, {
        onFrame: async () => { await hands2.send({ image: video2 }); },
        width: 640,
        height: 480,
      });
      camera2.start();
    }

    modelStatusEl.textContent = '실행 중';
    modelStatusEl.className = 'status online';
    isRunning = true;
    camBtn.textContent = '📷 카메라 중지';
    camBtn.classList.add('running');
  }

  function stopCameras() {
    if (camera1) { camera1.stop(); camera1 = null; }
    if (camera2) { camera2.stop(); camera2 = null; }
    if (hands1) { hands1.close(); hands1 = null; }
    if (hands2) { hands2.close(); hands2 = null; }

    [video1, video2].forEach(v => {
      if (v.srcObject) {
        v.srcObject.getTracks().forEach(t => t.stop());
        v.srcObject = null;
      }
    });

    [ctx1, ctx2].forEach(c => c.clearRect(0, 0, 640, 480));
    [indicator1, indicator2].forEach(ind => ind.classList.remove('active'));

    modelStatusEl.textContent = '중지됨';
    modelStatusEl.className = 'status offline';
    isRunning = false;
    camBtn.textContent = '📷 카메라 시작';
    camBtn.classList.remove('running');
  }

  // ---------- UI 이벤트 ----------
  camBtn.addEventListener('click', () => {
    if (isRunning) {
      stopCameras();
    } else {
      startCameras().catch(err => {
        console.error('카메라 시작 실패:', err);
        alert('카메라를 시작할 수 없습니다: ' + err.message);
      });
    }
  });

  window.addEventListener('beforeunload', stopCameras);

  // ---------- Init ----------
  populateCameras();
})();
