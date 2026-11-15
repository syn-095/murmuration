// Forwards raw mic samples to the main thread in 1024-sample chunks, tagged with the context frame.
// All DSP happens on the main thread: timestamps are sample-indexed, so main-thread jitter doesn't matter.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 1024; this.buf = new Float32Array(this.size); this.n = 0; this.start = 0; this.muted = false;
    this.port.onmessage = e => { if ('muted' in e.data) this.muted = e.data.muted; };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (this.n === 0) this.start = currentFrame;
    const len = ch ? ch.length : 128;
    if (ch && !this.muted) this.buf.set(ch, this.n); else this.buf.fill(0, this.n, this.n + len);
    this.n += len;
    if (this.n >= this.size) {
      this.port.postMessage({ frame: this.start, data: this.buf }, [this.buf.buffer]);
      this.buf = new Float32Array(this.size); this.n = 0;
    }
    return true;
  }
}
registerProcessor('murmur-capture', Capture);
