"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // src/audio/core/limiterCore.ts
  var LimiterCore = class {
    constructor(sampleRate2, ceilingDb = -0.5, lookaheadMs = 3, releaseMs = 120) {
      __publicField(this, "len");
      __publicField(this, "dl");
      __publicField(this, "dr");
      __publicField(this, "write", 0);
      __publicField(this, "env", 1);
      __publicField(this, "release");
      __publicField(this, "dqVal");
      __publicField(this, "dqIdx");
      __publicField(this, "dqHead", 0);
      __publicField(this, "dqTail", 0);
      __publicField(this, "n", 0);
      __publicField(this, "box");
      __publicField(this, "boxSum");
      __publicField(this, "boxPos", 0);
      __publicField(this, "ceiling");
      __publicField(this, "grDb", 0);
      this.len = Math.max(8, Math.round(sampleRate2 * lookaheadMs / 1e3));
      this.dl = new Float32Array(this.len);
      this.dr = new Float32Array(this.len);
      this.dqVal = new Float32Array(this.len + 1);
      this.dqIdx = new Int32Array(this.len + 1);
      this.box = new Float64Array(this.len).fill(1);
      this.boxSum = this.len;
      this.ceiling = Math.pow(10, ceilingDb / 20);
      this.release = 1 - Math.exp(-1 / (sampleRate2 * releaseMs / 1e3));
    }
    get latencyFrames() {
      return this.len;
    }
    process(inL, inR, outL, outR) {
      let minGain = 1;
      const cap = this.len + 1;
      for (let i = 0; i < inL.length; i++) {
        const a = inL[i];
        const b = inR[i];
        const peak = Math.max(Math.abs(a), Math.abs(b));
        const req = peak > this.ceiling ? this.ceiling / peak : 1;
        this.env = req < this.env ? req : this.env + (1 - this.env) * this.release;
        const idx = this.n++;
        while (this.dqHead !== this.dqTail) {
          const last = (this.dqTail - 1 + cap) % cap;
          if (this.dqVal[last] >= this.env) this.dqTail = last;
          else break;
        }
        this.dqVal[this.dqTail] = this.env;
        this.dqIdx[this.dqTail] = idx;
        this.dqTail = (this.dqTail + 1) % cap;
        while (this.dqIdx[this.dqHead] <= idx - this.len) this.dqHead = (this.dqHead + 1) % cap;
        const m = this.dqVal[this.dqHead];
        this.boxSum += m - this.box[this.boxPos];
        this.box[this.boxPos] = m;
        this.boxPos = (this.boxPos + 1) % this.len;
        const g = Math.min(1, this.boxSum / this.len);
        const dL = this.dl[this.write];
        const dR = this.dr[this.write];
        this.dl[this.write] = a;
        this.dr[this.write] = b;
        this.write = (this.write + 1) % this.len;
        const c = this.ceiling;
        const oL = dL * g;
        const oR = dR * g;
        outL[i] = oL > c ? c : oL < -c ? -c : oL;
        outR[i] = oR > c ? c : oR < -c ? -c : oR;
        if (g < minGain) minGain = g;
      }
      if (this.n > 1e9) {
        const shift = this.n - this.len * 2;
        for (let i = 0; i < cap; i++) this.dqIdx[i] -= shift;
        this.n -= shift;
      }
      this.grDb = 20 * Math.log10(minGain);
    }
  };

  // src/audio/worklets/master.worklet.ts
  var LimiterProcessor = class extends AudioWorkletProcessor {
    constructor() {
      super(...arguments);
      __publicField(this, "core", new LimiterCore(sampleRate));
      __publicField(this, "count", 0);
    }
    process(inputs, outputs) {
      const i = inputs[0];
      const o = outputs[0];
      if (!i || i.length === 0) {
        for (const c of o) c.fill(0);
        this.core.process(new Float32Array(128), new Float32Array(128), o[0], o[1] ?? o[0]);
        return true;
      }
      this.core.process(i[0], i[1] ?? i[0], o[0], o[1] ?? o[0]);
      if (++this.count % 16 === 0) this.port.postMessage({ gr: this.core.grDb });
      return true;
    }
  };
  registerProcessor("mixr-limiter", LimiterProcessor);
  var RecorderProcessor = class extends AudioWorkletProcessor {
    constructor() {
      super();
      __publicField(this, "armed", false);
      __publicField(this, "bl", new Float32Array(16384));
      __publicField(this, "br", new Float32Array(16384));
      __publicField(this, "w", 0);
      this.port.onmessage = (e) => {
        if (e.data.type === "start") {
          this.armed = true;
          this.w = 0;
        }
        if (e.data.type === "stop") {
          this.flush();
          this.armed = false;
          this.port.postMessage({ type: "stopped" });
        }
      };
    }
    flush() {
      if (this.w === 0) return;
      const l = this.bl.slice(0, this.w);
      const r = this.br.slice(0, this.w);
      this.port.postMessage({ type: "chunk", left: l, right: r }, [l.buffer, r.buffer]);
      this.w = 0;
    }
    process(inputs, outputs) {
      const i = inputs[0];
      const o = outputs[0];
      const n = o[0].length;
      for (let c = 0; c < o.length; c++) {
        if (i[c]) o[c].set(i[c]);
        else o[c].fill(0);
      }
      if (this.armed) {
        if (i && i[0]) {
          this.bl.set(i[0], this.w);
          this.br.set(i[1] ?? i[0], this.w);
        }
        this.w += n;
        if (this.w + n > this.bl.length) this.flush();
      }
      return true;
    }
  };
  registerProcessor("mixr-recorder", RecorderProcessor);
})();
