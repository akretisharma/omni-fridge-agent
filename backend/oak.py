# oak.py
#
# Luxonis OAK camera -> MJPEG. OAK cameras aren't UVC webcams, so the browser
# can't open them with getUserMedia; instead this backend reads frames with the
# DepthAI library and main.py serves them as a multipart MJPEG stream that the
# page shows in an <img> and samples like any other camera.
#
# depthai/opencv are optional: without them (or without a device) the app just
# offers the computer camera.
#
# The camera thread starts on the first request and shuts itself down (releasing
# the USB device) after IDLE_STOP_S seconds with no viewers.

import asyncio
import os
import threading
import time
from typing import Optional

try:
    import cv2
    import depthai as dai
except ImportError:  # optional dependency
    cv2 = dai = None

WIDTH, HEIGHT, FPS = 1280, 720, 15
JPEG_QUALITY = 80
IDLE_STOP_S = 10
# USB2 by default: on some hosts/cables the USB3 reboot makes the device vanish
# (X_LINK_DEVICE_NOT_FOUND). 15 fps at 720p is well within USB2. Set to SUPER for USB3.


class OakCamera:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._jpeg: Optional[bytes] = None
        self._seq = 0
        self._last_access = 0.0
        self.error: Optional[str] = None

    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def available(self) -> bool:
        if dai is None:
            return False
        if self.running:
            return True  # we're holding the device, so it won't be listed as free
        try:
            return len(dai.Device.getAllAvailableDevices()) > 0
        except Exception:
            return False

    def status(self) -> dict:
        return {
            "installed": dai is not None,
            "available": self.available(),
            "running": self.running,
            "error": self.error,
        }

    def ensure_running(self) -> None:
        self._last_access = time.time()
        with self._lock:
            if self.running:
                return
            if dai is None:
                self.error = "depthai is not installed (pip install depthai opencv-python-headless)"
                return
            self.error = None
            self._thread = threading.Thread(target=self._run, name="oak-camera", daemon=True)
            self._thread.start()

    def _run(self) -> None:
        device = None
        try:
            # read here, not at import, so backend/.env (loaded after this module is imported) applies
            max_usb = os.getenv("OAK_MAX_USB", "HIGH")
            device = dai.Device(maxUsbSpeed=getattr(dai.UsbSpeed, max_usb))
            with dai.Pipeline(device) as pipeline:
                cam = pipeline.create(dai.node.Camera).build()
                queue = cam.requestOutput((WIDTH, HEIGHT), dai.ImgFrame.Type.BGR888p, fps=FPS).createOutputQueue()
                pipeline.start()
                while pipeline.isRunning() and time.time() - self._last_access < IDLE_STOP_S:
                    frame = queue.get().getCvFrame()
                    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
                    if ok:
                        self._jpeg = buf.tobytes()
                        self._seq += 1
        except Exception as err:
            self.error = str(err)
            print(f"OAK camera error: {err}")
        finally:
            self._jpeg = None
            if device is not None:
                try:
                    device.close()
                except Exception:
                    pass

    async def mjpeg(self):
        """Async generator of multipart MJPEG chunks; ends when the client disconnects."""
        self.ensure_running()
        last_seq = -1
        while True:
            self._last_access = time.time()
            jpeg, seq = self._jpeg, self._seq
            if jpeg is not None and seq != last_seq:
                last_seq = seq
                yield (
                    b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                    + str(len(jpeg)).encode()
                    + b"\r\n\r\n"
                    + jpeg
                    + b"\r\n"
                )
            elif not self.running:
                if dai is None:
                    return
                await asyncio.sleep(2)  # crashed or idled out: back off, then retry
                self.ensure_running()
            else:
                await asyncio.sleep(0.03)


oak = OakCamera()
