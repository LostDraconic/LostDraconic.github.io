"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // src/audio/core/deckCore.ts
  var GRAIN = 2048;
  var HOP = GRAIN / 2;
  var SEARCH = 256;
  var DECIM = 4;
  var FADE = 256;
  var PLAY_FADE = 64;
  var hann = new Float32Array(GRAIN);
  for (let i = 0; i < GRAIN; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / GRAIN);
  var DeckCore = class {
    constructor() {
      __publicField(this, "layers", [null, null, null, null, null]);
      __publicField(this, "mono", null);
      __publicField(this, "length", 0);
      __publicField(this, "pos", 0);
      __publicField(this, "playing", false);
      __publicField(this, "ended", false);
      __publicField(this, "tempo", 1);
      __publicField(this, "keyLock", true);
      __publicField(this, "loopStart", 0);
      __publicField(this, "loopLen", 0);
      __publicField(this, "events", []);
      __publicField(this, "tempoInc", 0);
      __publicField(this, "tempoLeft", 0);
      __publicField(this, "rate", 1);
      __publicField(this, "spinLeft", 0);
      __publicField(this, "spinTotal", 0);
      __publicField(this, "spinKind", "brake");
      __publicField(this, "spinStop", false);
      __publicField(this, "spinFrom", 1);
      __publicField(this, "scratching", false);
      __publicField(this, "scratchTarget", 0);
      __publicField(this, "scratchRate", 0);
      __publicField(this, "nudge", 0);
      __publicField(this, "level", 0);
      // play/stop gate
      __publicField(this, "levelTarget", 0);
      __publicField(this, "pendingStop", false);
      __publicField(this, "attack", 1);
      // 0..1 ramp after a jump
      __publicField(this, "voices", []);
      __publicField(this, "grainIn", 0);
      __publicField(this, "lastSrc", -1);
      __publicField(this, "wasWsola", false);
      __publicField(this, "gains", [1, 0, 0, 0, 0]);
      __publicField(this, "gainTarget", [1, 0, 0, 0, 0]);
      __publicField(this, "gainInc", [0, 0, 0, 0, 0]);
      __publicField(this, "gainLeft", 0);
      __publicField(this, "sl", 0);
      __publicField(this, "sr", 0);
    }
    /** Load a stereo buffer. Positions and pending events are reset. */
    load(left, right) {
      this.layers = [[left, right], null, null, null, null];
      this.length = left.length;
      const m = new Float32Array(Math.ceil(left.length / DECIM));
      for (let i = 0; i < m.length; i++) {
        const j = i * DECIM;
        m[i] = 0.5 * (left[j] + right[j]);
      }
      this.mono = m;
      this.reset();
    }
    /** Attach separated stems; index 1=vocals 2=drums 3=bass 4=other. */
    loadStem(index, left, right) {
      this.layers[index] = [left, right];
    }
    unload() {
      this.layers = [null, null, null, null, null];
      this.mono = null;
      this.length = 0;
      this.reset();
    }
    reset() {
      this.pos = 0;
      this.playing = false;
      this.ended = false;
      this.tempo = 1;
      this.rate = 1;
      this.tempoLeft = 0;
      this.loopLen = 0;
      this.events = [];
      this.voices = [];
      this.grainIn = 0;
      this.lastSrc = -1;
      this.level = 0;
      this.levelTarget = 0;
      this.pendingStop = false;
      this.spinLeft = 0;
      this.scratching = false;
      this.gains = [1, 0, 0, 0, 0];
      this.gainTarget = [1, 0, 0, 0, 0];
      this.gainLeft = 0;
      this.attack = 1;
    }
    /** Queue an event at an absolute context frame. Past-due events fire at the next render. */
    schedule(ev) {
      let i = this.events.length;
      while (i > 0 && this.events[i - 1].frame > ev.frame) i--;
      this.events.splice(i, 0, ev);
    }
    clearEvents() {
      this.events = [];
    }
    /** Manual-override: drop anything scheduled and stop spinning/ramping where we are. */
    cancelAutomation() {
      this.events = [];
      this.tempoLeft = 0;
      this.spinLeft = 0;
    }
    setKeyLock(on) {
      this.keyLock = on;
    }
    setTempoLive(ratio) {
      this.tempoInc = (ratio - this.tempo) / 512;
      this.tempoLeft = 512;
    }
    setNudge(amount) {
      this.nudge = amount;
    }
    scratchBegin() {
      if (!this.scratching) {
        this.scratching = true;
        this.scratchRate = this.playing ? this.rate : 0;
        this.scratchTarget = 0;
        this.levelTarget = 1;
      }
    }
    scratchMove(rate) {
      this.scratchTarget = rate;
    }
    scratchEnd() {
      this.scratching = false;
      if (!this.playing) this.levelTarget = 0;
      this.pendingStop = false;
    }
    render(outL, outR, startFrame) {
      const n = outL.length;
      let off = 0;
      while (off < n) {
        const nowFrame = startFrame + off;
        while (this.events.length && this.events[0].frame <= nowFrame) this.apply(this.events.shift());
        let count = n - off;
        if (this.events.length) count = Math.min(count, this.events[0].frame - nowFrame);
        this.renderSegment(outL, outR, off, count);
        off += count;
      }
    }
    status(frame) {
      return {
        frame,
        pos: this.pos,
        rate: this.scratching ? this.scratchRate : this.rate,
        tempo: this.tempo,
        playing: this.playing,
        loopStart: this.loopStart,
        loopLen: this.loopLen,
        ended: this.ended
      };
    }
    apply(ev) {
      switch (ev.type) {
        case "play":
          if (ev.tempo !== void 0) {
            this.tempo = ev.tempo;
            this.tempoLeft = 0;
          }
          if (ev.pos !== void 0) {
            if (this.level > 1e-3 && this.playing) this.jump(ev.pos);
            else {
              this.pos = ev.pos;
              this.restartGrains();
            }
          } else if (!this.playing) this.restartGrains();
          this.playing = true;
          this.ended = false;
          this.pendingStop = false;
          this.levelTarget = 1;
          this.spinLeft = 0;
          break;
        case "stop":
          this.playing = false;
          this.levelTarget = this.scratching ? 1 : 0;
          this.pendingStop = false;
          this.spinLeft = 0;
          break;
        case "seek":
          if (this.playing || this.level > 1e-3) this.jump(ev.pos);
          else {
            this.pos = ev.pos;
            this.restartGrains();
          }
          break;
        case "loopOn":
          this.loopStart = ev.start;
          this.loopLen = ev.length;
          if (ev.jump) this.jump(ev.start);
          break;
        case "loopOff":
          this.loopLen = 0;
          break;
        case "tempo":
          if (ev.rampFrames && ev.rampFrames > 0) {
            this.tempoLeft = ev.rampFrames;
            this.tempoInc = (ev.ratio - this.tempo) / ev.rampFrames;
          } else {
            this.tempo = ev.ratio;
            this.tempoLeft = 0;
          }
          break;
        case "spin":
          this.spinLeft = ev.durFrames;
          this.spinTotal = ev.durFrames;
          this.spinKind = ev.kind;
          this.spinStop = ev.stopAfter;
          this.spinFrom = this.rate;
          this.loopLen = 0;
          break;
        case "stems":
          for (let i = 0; i < 5; i++) {
            this.gainTarget[i] = this.layers[i] || i === 0 ? ev.gains[i] : 0;
            this.gainInc[i] = (this.gainTarget[i] - this.gains[i]) / Math.max(1, ev.rampFrames);
          }
          this.gainLeft = Math.max(1, ev.rampFrames);
          break;
      }
    }
    /** Click-free position jump: existing audio fades as the new position fades in. */
    jump(to) {
      for (const v of this.voices) if (v.fade < 0) v.fade = FADE;
      if (!this.wasWsola) this.voices.push({ src: this.pos, phase: 0, fade: FADE, rate: this.rate, windowed: false });
      this.pos = to;
      this.attack = 0;
      this.restartGrains();
    }
    /** Begin a grain at the Hann peak so it perfectly reconstructs with the next normal grain. */
    restartGrains() {
      this.voices = this.voices.filter((v) => v.fade >= 0);
      this.voices.push({ src: Math.round(this.pos), phase: HOP, fade: -1, rate: 1, windowed: true });
      this.lastSrc = Math.round(this.pos);
      this.grainIn = HOP;
    }
    /** WSOLA: pick the grain start near the nominal position that best continues the previous grain. */
    spawnGrain() {
      const nominal = this.pos + (this.rate - 1) * HOP;
      const cont = this.lastSrc + HOP;
      let best;
      if (this.lastSrc < 0 || !this.mono) best = Math.round(nominal);
      else if (Math.abs(cont - nominal) < 1.5) best = cont;
      else best = this.searchBest(cont, nominal);
      this.voices.push({ src: best, phase: 0, fade: -1, rate: 1, windowed: true });
      this.lastSrc = best;
      this.grainIn = HOP;
    }
    searchBest(cont, nominal) {
      const m = this.mono;
      const refStart = Math.floor(cont / DECIM);
      const len = Math.floor(HOP / DECIM);
      const center = Math.floor(nominal / DECIM);
      const lags = Math.floor(SEARCH / DECIM);
      if (refStart < 0 || refStart + len >= m.length) return Math.round(nominal);
      let bestScore = -Infinity;
      let bestLag = 0;
      const contLag = Math.round((cont - nominal) / DECIM);
      const lo = contLag < 0 ? Math.max(-lags, contLag) : -lags;
      const hi = contLag > 0 ? Math.min(lags, contLag) : lags;
      for (let lag = lo; lag <= hi; lag++) {
        const c = center + lag;
        if (c < 0 || c + len >= m.length) continue;
        let xy = 0;
        let yy = 1e-9;
        for (let i = 0; i < len; i++) {
          const y = m[c + i];
          xy += m[refStart + i] * y;
          yy += y * y;
        }
        const d = Math.abs(lag) / lags;
        const score = xy / Math.sqrt(yy) * (1 - 0.4 * d) - 0.02 * d;
        if (score > bestScore) {
          bestScore = score;
          bestLag = lag;
        }
      }
      return Math.max(0, center * DECIM + bestLag * DECIM);
    }
    /** Sum all active layers at an integer frame into sl/sr. */
    read(i) {
      if (i < 0 || i >= this.length) {
        this.sl = 0;
        this.sr = 0;
        return;
      }
      const g = this.gains;
      let l = 0;
      let r = 0;
      for (let k = 0; k < 5; k++) {
        const gk = g[k];
        if (gk === 0) continue;
        const lay = this.layers[k];
        if (!lay) continue;
        l += lay[0][i] * gk;
        r += lay[1][i] * gk;
      }
      this.sl = l;
      this.sr = r;
    }
    /** Catmull-Rom cubic interpolation for variable-rate (vinyl) playback. */
    readCubic(p) {
      const i = Math.floor(p);
      const t = p - i;
      this.read(i - 1);
      const al = this.sl;
      const ar = this.sr;
      this.read(i);
      const bl = this.sl;
      const br = this.sr;
      this.read(i + 1);
      const cl = this.sl;
      const cr = this.sr;
      this.read(i + 2);
      const dl = this.sl;
      const dr = this.sr;
      this.sl = bl + 0.5 * t * (cl - al + t * (2 * al - 5 * bl + 4 * cl - dl + t * (3 * (bl - cl) + dl - al)));
      this.sr = br + 0.5 * t * (cr - ar + t * (2 * ar - 5 * br + 4 * cr - dr + t * (3 * (br - cr) + dr - ar)));
    }
    spinRate() {
      const x = 1 - this.spinLeft / this.spinTotal;
      if (this.spinKind === "brake") return this.spinFrom * (1 - x) * (1 - x);
      if (x < 0.08) return this.spinFrom + (-5 - this.spinFrom) * (x / 0.08);
      const y = (x - 0.08) / 0.92;
      return -5 * (1 - y) * (1 - y);
    }
    renderSegment(outL, outR, off, n) {
      const hasAudio = this.length > 0;
      for (let i = off; i < off + n; i++) {
        if (this.level < this.levelTarget) this.level = Math.min(this.levelTarget, this.level + 1 / PLAY_FADE);
        else if (this.level > this.levelTarget) this.level = Math.max(this.levelTarget, this.level - 1 / PLAY_FADE);
        if (!hasAudio || this.level === 0 && !this.playing && !this.scratching) {
          outL[i] = 0;
          outR[i] = 0;
          if (this.voices.length) this.voices = [];
          this.wasWsola = false;
          continue;
        }
        if (this.gainLeft > 0) {
          for (let k = 0; k < 5; k++) this.gains[k] += this.gainInc[k];
          if (--this.gainLeft === 0) for (let k = 0; k < 5; k++) this.gains[k] = this.gainTarget[k];
        }
        if (this.tempoLeft > 0) {
          this.tempo += this.tempoInc;
          this.tempoLeft--;
        }
        const spinning = this.spinLeft > 0;
        let rate;
        if (this.scratching) {
          this.scratchRate += (this.scratchTarget - this.scratchRate) * 0.012;
          rate = this.scratchRate;
        } else if (spinning) {
          rate = this.spinRate();
          if (--this.spinLeft === 0 && this.spinStop) {
            this.playing = false;
            this.levelTarget = 0;
          }
        } else if (this.playing) {
          rate = this.tempo * (1 + this.nudge);
        } else {
          rate = 0;
        }
        this.rate = rate;
        const useWsola = this.keyLock && !this.scratching && !spinning && this.playing;
        if (useWsola !== this.wasWsola) {
          if (useWsola) {
            const p = this.pos;
            this.jump(p);
          } else {
            for (const v of this.voices) if (v.fade < 0) v.fade = FADE;
            this.attack = 0;
          }
          this.wasWsola = useWsola;
        }
        let l = 0;
        let r = 0;
        if (useWsola) {
          if (this.grainIn <= 0) this.spawnGrain();
          this.grainIn--;
        } else if (rate !== 0 || this.level > 0) {
          this.readCubic(this.pos);
          l = this.sl;
          r = this.sr;
        }
        let voiceSumL = 0;
        let voiceSumR = 0;
        let attackL = 0;
        let attackR = 0;
        for (let v = this.voices.length - 1; v >= 0; v--) {
          const vo = this.voices[v];
          let g = 1;
          if (vo.windowed) {
            if (vo.phase >= GRAIN) {
              this.voices.splice(v, 1);
              continue;
            }
            g = hann[vo.phase++];
          }
          if (vo.rate === 1 && vo.windowed) {
            this.read(vo.src++);
          } else {
            this.readCubic(vo.src);
            vo.src += vo.rate;
          }
          if (vo.fade >= 0) {
            g *= vo.fade / FADE;
            vo.fade--;
            if (vo.fade < 0) {
              this.voices.splice(v, 1);
              continue;
            }
            voiceSumL += this.sl * g;
            voiceSumR += this.sr * g;
          } else {
            attackL += this.sl * g;
            attackR += this.sr * g;
          }
        }
        if (this.attack < 1) this.attack = Math.min(1, this.attack + 1 / FADE);
        l = (l + attackL) * this.attack + voiceSumL;
        r = (r + attackR) * this.attack + voiceSumR;
        outL[i] = l * this.level;
        outR[i] = r * this.level;
        this.pos += rate;
        if (this.loopLen > 0 && rate > 0 && this.pos >= this.loopStart + this.loopLen) {
          this.jump(this.pos - this.loopLen);
        }
        if (this.pos < 0) {
          this.pos = 0;
          if (this.scratchTarget < 0) this.scratchTarget = 0;
        }
        if (this.pos >= this.length && this.playing) {
          this.pos = this.length;
          this.playing = false;
          this.ended = true;
          this.levelTarget = 0;
          this.voices = [];
        }
      }
    }
  };

  // src/audio/worklets/deck.worklet.ts
  var DeckProcessor = class extends AudioWorkletProcessor {
    constructor() {
      super();
      __publicField(this, "core", new DeckCore());
      __publicField(this, "count", 0);
      __publicField(this, "endedSent", false);
      this.port.onmessage = (e) => {
        const m = e.data;
        switch (m.type) {
          case "load":
            this.core.load(m.left, m.right);
            this.endedSent = false;
            this.port.postMessage({ type: "loaded", token: m.token });
            break;
          case "stem":
            this.core.loadStem(m.index, m.left, m.right);
            this.port.postMessage({ type: "stemLoaded", index: m.index, token: m.token });
            break;
          case "unload":
            this.core.unload();
            break;
          case "event":
            this.core.schedule(m.event);
            this.endedSent = false;
            break;
          case "events":
            for (const ev of m.events) this.core.schedule(ev);
            this.endedSent = false;
            break;
          case "clear":
            this.core.clearEvents();
            break;
          case "cancel":
            this.core.cancelAutomation();
            break;
          case "keyLock":
            this.core.setKeyLock(m.on);
            break;
          case "tempo":
            this.core.setTempoLive(m.ratio);
            break;
          case "nudge":
            this.core.setNudge(m.amount);
            break;
          case "scratchBegin":
            this.core.scratchBegin();
            break;
          case "scratchMove":
            this.core.scratchMove(m.rate);
            break;
          case "scratchEnd":
            this.core.scratchEnd();
            break;
          // ports are ordered: answering a ping proves every earlier message has been applied
          case "ping":
            this.port.postMessage({ type: "pong", token: m.token });
            break;
        }
      };
    }
    process(_inputs, outputs) {
      const out = outputs[0];
      const l = out[0];
      const r = out[1] ?? out[0];
      this.core.render(l, r, currentFrame);
      if (++this.count % 4 === 0) {
        this.port.postMessage({ type: "status", status: this.core.status(currentFrame + l.length) });
      }
      if (this.core.ended && !this.endedSent) {
        this.endedSent = true;
        this.port.postMessage({ type: "ended" });
      }
      return true;
    }
  };
  registerProcessor("mixr-deck", DeckProcessor);
})();
