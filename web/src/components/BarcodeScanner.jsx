import { useEffect, useRef, useState } from "react";
import { Camera, CameraOff, Flashlight } from "lucide-react";
import { Button, cx } from "./ui.jsx";

const FORMATS = ["code_128", "code_39", "code_93", "codabar", "ean_13", "ean_8", "itf", "upc_a", "upc_e", "qr_code", "data_matrix", "pdf417"];

/**
 * Camera barcode / QR scanner. Uses the browser's BarcodeDetector where available (Chrome, Android)
 * and loads the ZXing decoder on demand elsewhere (iPhone Safari, Firefox). Calls onCode(text);
 * the same code is ignored for a few seconds so one parcel isn't scanned twice.
 */
export default function BarcodeScanner({ onCode, paused }) {
  const video = useRef(null);
  const stream = useRef(null);
  const stop = useRef(() => {});
  const last = useRef({ code: "", at: 0 });
  const pausedRef = useRef(paused);
  const [on, setOn] = useState(false);
  const [error, setError] = useState(null);
  const [torch, setTorch] = useState(null); // null = not supported
  pausedRef.current = paused;

  const emit = (text) => {
    const code = String(text || "").trim();
    if (!code || pausedRef.current) return;
    const now = Date.now();
    if (code === last.current.code && now - last.current.at < 3500) return;
    last.current = { code, at: now };
    onCode(code);
  };

  async function start() {
    setError(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      stream.current = s;
      const v = video.current;
      v.srcObject = s;
      await v.play();
      const track = s.getVideoTracks()[0];
      if (track.getCapabilities?.().torch) setTorch(false);
      setOn(true);

      if ("BarcodeDetector" in window) {
        const supported = (await window.BarcodeDetector.getSupportedFormats?.()) || FORMATS;
        const detector = new window.BarcodeDetector({ formats: FORMATS.filter((f) => supported.includes(f)) });
        let active = true;
        let busy = false;
        const tick = async () => {
          if (!active) return;
          if (!busy && v.readyState >= 2) {
            busy = true;
            try {
              const found = await detector.detect(v);
              if (found[0]) emit(found[0].rawValue);
            } catch {
              /* frame not ready */
            }
            busy = false;
          }
          setTimeout(() => requestAnimationFrame(tick), 180); // ~5 checks/sec keeps the phone cool
        };
        tick();
        stop.current = () => {
          active = false;
        };
      } else {
        const { BrowserMultiFormatReader } = await import("@zxing/browser"); // loaded only on browsers without BarcodeDetector
        const reader = new BrowserMultiFormatReader();
        const controls = await reader.decodeFromVideoElement(v, (result) => result && emit(result.getText()));
        stop.current = () => controls.stop();
      }
    } catch (err) {
      setError(err.name === "NotAllowedError" ? "Camera permission was denied. Allow camera access in your browser settings." : err.name === "NotFoundError" ? "No camera found on this device." : err.message);
      halt();
    }
  }

  function halt() {
    stop.current();
    stop.current = () => {};
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setOn(false);
    setTorch(null);
  }

  async function toggleTorch() {
    const track = stream.current?.getVideoTracks()[0];
    if (!track) return;
    await track.applyConstraints({ advanced: [{ torch: !torch }] }).catch(() => {});
    setTorch(!torch);
  }

  useEffect(() => halt, []);

  return (
    <div className="relative overflow-hidden rounded-2xl bg-navy-950">
      <video ref={video} className={cx("aspect-[4/3] w-full object-cover", !on && "opacity-0")} playsInline muted aria-label="Camera preview" />
      {on && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="relative h-2/5 w-4/5 rounded-2xl ring-2 ring-brand-400/90 [box-shadow:0_0_0_100vmax_rgb(7_17_31/0.45)]">
            <div className="scan-line absolute inset-x-3 top-1/2 h-0.5 rounded-full bg-brand-400 shadow-[0_0_12px_2px_rgb(37_211_102/0.7)]" />
          </div>
        </div>
      )}
      {!on && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-slate-300">
          <Camera className="h-10 w-10 text-brand-400" />
          <p className="text-sm">{error || "Point the camera at the courier barcode or the order QR."}</p>
          <Button onClick={start}>
            <Camera className="h-4 w-4" /> Start camera
          </Button>
        </div>
      )}
      {on && (
        <div className="absolute bottom-3 right-3 flex gap-2">
          {torch !== null && (
            <button onClick={toggleTorch} className={cx("rounded-full p-2.5 backdrop-blur", torch ? "bg-amber-400 text-navy-950" : "bg-white/15 text-white")} aria-label="Flashlight" aria-pressed={!!torch}>
              <Flashlight className="h-5 w-5" />
            </button>
          )}
          <button onClick={halt} className="rounded-full bg-white/15 p-2.5 text-white backdrop-blur" aria-label="Stop camera">
            <CameraOff className="h-5 w-5" />
          </button>
        </div>
      )}
    </div>
  );
}
