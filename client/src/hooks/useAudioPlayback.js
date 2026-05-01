import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Audio format from APK:
 * - Sample Rate: 16kHz
 * - Bit Depth: 16-bit signed PCM
 * - Channels: Mono
 * 
 * Binary frame format from server:
 * [2-byte BE length][deviceId UTF-8][audio payload]
 * 
 * Audio payload format:
 * [0x4D][0x4D][version][codec][...data]
 * version 0x01: [codec][pcm/mulaw data]
 * version 0x02: [codec][4-byte BE length][pcm/mulaw data]
 * 
 * Codecs:
 * 0x00 = PCM16 16kHz
 * 0x01 = µ-law 8kHz
 * 0x10 = HQ PCM16 16kHz
 * 0x11 = HQ µ-law
 */

const SAMPLE_RATE = 16000;
const BUFFER_SIZE = 4096;

// µ-law decompression table
const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const mu = ~i & 0xff;
  const sign = mu & 0x80 ? -1 : 1;
  const exponent = mu >> 4 & 0x07;
  const mantissa = mu & 0x0f;
  const sample = sign * (((mantissa << 1) + 33 << exponent) - 33);
  MULAW_DECODE_TABLE[i] = sample;
}
export function useAudioPlayback() {
  const [state, setState] = useState({
    isPlaying: false,
    volume: 1.0,
    latencyMs: 0,
    bufferHealth: 0,
    lastDeviceId: null,
    waveform: null
  });
  const audioContextRef = useRef(null);
  const gainNodeRef = useRef(null);
  const audioQueueRef = useRef([]);
  const isPlayingRef = useRef(false);
  const scriptProcessorRef = useRef(null);
  const workletNodeRef = useRef(null);
  const workletQueueSamplesRef = useRef(0);
  const usingWorkletRef = useRef(false);
  const waveformRef = useRef(new Float32Array(128));
  const lastDeviceIdRef = useRef(null);
  const targetDeviceIdRef = useRef(null);
  const streamStartAtRef = useRef(0);
  // S-M5 fix: Use ref for volume to avoid stale closure in initAudioContext
  const volumeRef = useRef(1.0);
  // S-M1 fix: Throttle setState to ~10Hz instead of every audio frame
  const lastStateUpdateRef = useRef(0);

  // Parse audio frame from server
  const parseAudioFrame = useCallback((data, explicitDeviceId) => {
    if (data.byteLength < 4) return null;

    const audioData = new Uint8Array(data);

    // Check magic bytes
    if (audioData[0] !== 0x4d || audioData[1] !== 0x4d) {
      return null;
    }
    const version = audioData[2];
    const codec = audioData[3];
    let payloadStart = 4;
    let payloadLength = audioData.length - 4;

    // HQ mode (version 0x02) has 4-byte length prefix
    if (version === 0x02) {
      if (audioData.length < 8) return null;
      const audioView = new DataView(audioData.buffer, audioData.byteOffset);
      payloadLength = audioView.getUint32(4, false);
      payloadStart = 8;
      if (audioData.length < payloadStart + payloadLength) {
        payloadLength = audioData.length - payloadStart;
      }
    }
    const payload = audioData.slice(payloadStart, payloadStart + payloadLength);

    // Decode based on codec
    if (codec === 0x01 || codec === 0x11) {
      // µ-law: each byte → 16-bit sample, then upsample 8k→16k
      const mulaw8k = decodeMulaw(payload);
      const upsampled = upsample8kTo16k(mulaw8k);
      return {
        deviceId: explicitDeviceId || 'unknown',
        audio: upsampled,
        sampleRate: SAMPLE_RATE
      };
    } else {
      // PCM16: convert to float
      const floats = new Float32Array(Math.floor(payload.length / 2));
      const pcmView = new DataView(payload.buffer, payload.byteOffset, payload.length);
      for (let i = 0; i < floats.length; i++) {
        floats[i] = pcmView.getInt16(i * 2, true) / 32768.0;
      }
      return {
        deviceId: explicitDeviceId || 'unknown',
        audio: floats,
        sampleRate: SAMPLE_RATE
      };
    }
  }, []);

  // Initialize audio context
  // S-M5 fix: No dependency on state.volume — use volumeRef instead
  const initAudioContext = useCallback(async () => {
    if (audioContextRef.current) return;
    const ctx = new AudioContext({
      sampleRate: SAMPLE_RATE
    });
    audioContextRef.current = ctx;

    // ── Audio processing chain for far-voice clarity ──
    // Source → Compressor → Highpass → Gain → Destination
    
    // 1. DynamicsCompressor: auto-levels quiet far-field speech
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;   // Start compressing at -18dB (catches quiet speech)
    compressor.knee.value = 20;         // Soft knee for natural sound
    compressor.ratio.value = 3;         // Gentle leveling, not hard limiting
    compressor.attack.value = 0.003;    // Fast attack to catch speech transients
    compressor.release.value = 0.25;    // Slower release to avoid pumping

    // 2. Highpass filter: removes low-frequency hum/rumble
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 110;
    highpass.Q.value = 0.7;

    // 3. Notch filter: suppress mains hum around 60Hz
    const notch = ctx.createBiquadFilter();
    notch.type = 'notch';
    notch.frequency.value = 60;
    notch.Q.value = 12;

    // 4. Low-shelf cut: reduce bass buildup without thinning speech
    const lowShelf = ctx.createBiquadFilter();
    lowShelf.type = 'lowshelf';
    lowShelf.frequency.value = 180;
    lowShelf.gain.value = -4;

    // 5. Gain node: final volume boost
    const gainNode = ctx.createGain();
    gainNode.gain.value = volumeRef.current * 2.2;  // Lower boost to avoid amplifying noise
    gainNodeRef.current = gainNode;

    // Connect chain: compressor → highpass → notch → low-shelf → gain → output
    compressor.connect(highpass);
    highpass.connect(notch);
    notch.connect(lowShelf);
    lowShelf.connect(gainNode);
    gainNode.connect(ctx.destination);

    // Prefer AudioWorklet (real-time audio thread). Fallback to ScriptProcessor only if unavailable.
    if (ctx.audioWorklet) {
      try {
        const workletCode = `
          class PCMPlayerProcessor extends AudioWorkletProcessor {
            constructor() {
              super();
              this.queue = [];
              this.totalQueued = 0;
              this.frameCount = 0;
              this.port.onmessage = (event) => {
                const data = event.data || {};
                if (data.type === 'clear') {
                  this.queue = [];
                  this.totalQueued = 0;
                  return;
                }
                if (data.type === 'push' && data.chunk) {
                  const chunk = data.chunk instanceof Float32Array ? data.chunk : new Float32Array(data.chunk);
                  this.queue.push({ chunk, offset: 0 });
                  this.totalQueued += chunk.length;
                  const maxSamples = Number(data.maxSamples || 8000);
                  while (this.totalQueued > maxSamples && this.queue.length > 1) {
                    const dropped = this.queue.shift();
                    if (dropped) this.totalQueued -= (dropped.chunk.length - dropped.offset);
                  }
                }
              };
            }

            process(inputs, outputs) {
              const out = outputs[0][0];
              let written = 0;
              while (written < out.length && this.queue.length > 0) {
                const head = this.queue[0];
                const remaining = head.chunk.length - head.offset;
                const toCopy = Math.min(remaining, out.length - written);
                out.set(head.chunk.subarray(head.offset, head.offset + toCopy), written);
                written += toCopy;
                head.offset += toCopy;
                this.totalQueued -= toCopy;
                if (head.offset >= head.chunk.length) {
                  this.queue.shift();
                }
              }
              if (written < out.length) out.fill(0, written);

              this.frameCount++;
              if (this.frameCount % 6 === 0) {
                const waveform = new Array(128).fill(0);
                const step = Math.max(1, Math.floor(out.length / waveform.length));
                for (let i = 0; i < waveform.length; i++) {
                  let sum = 0;
                  const start = i * step;
                  const end = Math.min(start + step, out.length);
                  for (let j = start; j < end; j++) sum += Math.abs(out[j]);
                  waveform[i] = (end > start) ? (sum / (end - start)) : 0;
                }
                this.port.postMessage({
                  type: 'stats',
                  queueSamples: this.totalQueued,
                  waveform
                });
              }
              return true;
            }
          }
          registerProcessor('pcm-player-processor', PCMPlayerProcessor);
        `;
        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        const node = new AudioWorkletNode(ctx, 'pcm-player-processor', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1]
        });
        node.port.onmessage = event => {
          const msg = event.data;
          if (!msg || msg.type !== 'stats') return;
          workletQueueSamplesRef.current = Number(msg.queueSamples || 0);
          const waveform = waveformRef.current;
          if (Array.isArray(msg.waveform)) {
            const len = Math.min(waveform.length, msg.waveform.length);
            for (let i = 0; i < len; i++) waveform[i] = Number(msg.waveform[i]) || 0;
          }
          const now = Date.now();
          if (now - lastStateUpdateRef.current >= 100) {
            lastStateUpdateRef.current = now;
            const startupBoost = now - streamStartAtRef.current < 3000;
            const capSamples = startupBoost ? SAMPLE_RATE * 3 : SAMPLE_RATE * 1.5;
            const totalSamples = workletQueueSamplesRef.current;
            const bufferHealth = Math.min(1, totalSamples / capSamples);
            setState(prev => ({
              ...prev,
              bufferHealth,
              latencyMs: Math.round(totalSamples / SAMPLE_RATE * 1000),
              lastDeviceId: lastDeviceIdRef.current,
              waveform: new Float32Array(waveform)
            }));
          }
        };
        node.connect(compressor);
        workletNodeRef.current = node;
        usingWorkletRef.current = true;
        return;
      } catch {
        usingWorkletRef.current = false;
      }
    }

    const scriptProcessor = ctx.createScriptProcessor(BUFFER_SIZE, 1, 1);
    scriptProcessor.onaudioprocess = e => {
      const output = e.outputBuffer.getChannelData(0);
      const queue = audioQueueRef.current;
      let samplesNeeded = output.length;
      let outputOffset = 0;
      while (samplesNeeded > 0 && queue.length > 0) {
        const chunk = queue[0];
        const samplesToTake = Math.min(samplesNeeded, chunk.length);
        output.set(chunk.subarray(0, samplesToTake), outputOffset);
        outputOffset += samplesToTake;
        samplesNeeded -= samplesToTake;
        if (samplesToTake === chunk.length) {
          queue.shift();
        } else {
          queue[0] = chunk.subarray(samplesToTake);
        }
      }
      if (samplesNeeded > 0) output.fill(0, outputOffset);

      const waveform = waveformRef.current;
      const step = Math.max(1, Math.floor(output.length / waveform.length));
      for (let i = 0; i < waveform.length; i++) {
        let sum = 0;
        const start = i * step;
        const end = Math.min(start + step, output.length);
        for (let j = start; j < end; j++) sum += Math.abs(output[j]);
        waveform[i] = (end > start) ? (sum / (end - start)) : 0;
      }

      const now = Date.now();
      if (now - lastStateUpdateRef.current >= 100) {
        lastStateUpdateRef.current = now;
        const startupBoost = now - streamStartAtRef.current < 3000;
        const capSamples = startupBoost ? SAMPLE_RATE * 3 : SAMPLE_RATE * 1.5;
        const totalSamples = queue.reduce((acc, c) => acc + c.length, 0);
        const bufferHealth = Math.min(1, totalSamples / capSamples);
        setState(prev => ({
          ...prev,
          bufferHealth,
          latencyMs: Math.round(totalSamples / SAMPLE_RATE * 1000),
          lastDeviceId: lastDeviceIdRef.current,
          waveform: new Float32Array(waveform)
        }));
      }
    };
    scriptProcessor.connect(compressor);
    scriptProcessorRef.current = scriptProcessor;
    usingWorkletRef.current = false;
  }, []); // S-M5 fix: Empty dependency — volume is accessed via volumeRef

  // Start playback
  const start = useCallback(async () => {
    await initAudioContext();
    const ctx = audioContextRef.current;
    if (ctx && ctx.state === 'suspended') {
      await ctx.resume();
    }
    streamStartAtRef.current = Date.now();
    isPlayingRef.current = true;
    setState(prev => ({
      ...prev,
      isPlaying: true
    }));
  }, [initAudioContext]);

  // Stop playback
  const stop = useCallback(() => {
    isPlayingRef.current = false;
    audioQueueRef.current = [];
    workletQueueSamplesRef.current = 0;
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: 'clear' });
    }
    setState(prev => ({
      ...prev,
      isPlaying: false,
      bufferHealth: 0
    }));
  }, []);

  // Feed audio data
  const feedAudio = useCallback((data, deviceId) => {
    if (!isPlayingRef.current || !audioContextRef.current) return;

    // Route only selected device audio when a target is set.
    const targetDeviceId = targetDeviceIdRef.current;
    if (targetDeviceId && deviceId && deviceId !== targetDeviceId) {
      return;
    }
    if (deviceId) {
      lastDeviceIdRef.current = deviceId;
    }

    const parsed = parseAudioFrame(data, deviceId);
    if (!parsed) return;
    
    lastDeviceIdRef.current = parsed.deviceId;
    const startupBoost = Date.now() - streamStartAtRef.current < 3000;
    const maxSamples = startupBoost ? SAMPLE_RATE * 3 : SAMPLE_RATE * 1.5;

    if (usingWorkletRef.current && workletNodeRef.current) {
      const chunk = parsed.audio;
      workletNodeRef.current.port.postMessage({
        type: 'push',
        chunk: chunk.buffer,
        maxSamples
      }, [chunk.buffer]);
      return;
    }

    // ScriptProcessor fallback queue
    audioQueueRef.current.push(parsed.audio);

    let totalSamples = audioQueueRef.current.reduce((acc, c) => acc + c.length, 0);
    while (totalSamples > maxSamples && audioQueueRef.current.length > 1) {
      const removed = audioQueueRef.current.shift();
      if (removed) totalSamples -= removed.length;
    }

    // Track latency and device via refs — the throttled state update in
    // onaudioprocess will pick them up. DO NOT setState here: calling
    // setState on every audio frame (~60/sec) causes cascading React
    // re-renders that triggered the 80-commands/sec start_stream flood.
    lastDeviceIdRef.current = parsed.deviceId;
    // latencyMs is derived from queue in the throttled update
  }, [parseAudioFrame]);

  const setTargetDevice = useCallback(deviceId => {
    targetDeviceIdRef.current = deviceId || null;
    lastDeviceIdRef.current = deviceId || null;
    audioQueueRef.current = [];
    workletQueueSamplesRef.current = 0;
    streamStartAtRef.current = Date.now();
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: 'clear' });
    }
    setState(prev => ({
      ...prev,
      latencyMs: 0,
      bufferHealth: 0,
      lastDeviceId: deviceId || null
    }));
  }, []);

  // Set volume
  const setVolume = useCallback(volume => {
    const clamped = Math.max(0, Math.min(5, volume)); // Allow up to 5x volume from the UI
    // S-M5 fix: Update ref so initAudioContext always has current volume
    volumeRef.current = clamped;
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = clamped * 3.0;  // Match initAudioContext base boost
    }
    setState(prev => ({
      ...prev,
      volume: clamped
    }));
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (workletNodeRef.current) {
        workletNodeRef.current.disconnect();
      }
      if (scriptProcessorRef.current) {
        scriptProcessorRef.current.disconnect();
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    };
  }, []);
  return {
    state,
    feedAudio,
    setTargetDevice,
    setVolume,
    start,
    stop
  };
}

// Decode µ-law to Float32
function decodeMulaw(mulaw) {
  const output = new Float32Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) {
    output[i] = MULAW_DECODE_TABLE[mulaw[i]] / 32768.0;
  }
  return output;
}

// Upsample 8kHz to 16kHz using a light 4-tap FIR interpolator.
function upsample8kTo16k(input) {
  const output = new Float32Array(input.length * 2);
  if (input.length === 0) return output;
  for (let i = 0; i < input.length; i++) {
    const xm1 = input[Math.max(0, i - 1)];
    const x0 = input[i];
    const x1 = input[Math.min(input.length - 1, i + 1)];
    const x2 = input[Math.min(input.length - 1, i + 2)];

    output[i * 2] = 0.10 * xm1 + 0.40 * x0 + 0.40 * x1 + 0.10 * x2;
    output[i * 2 + 1] = 0.05 * xm1 + 0.45 * x0 + 0.45 * x1 + 0.05 * x2;
  }
  return output;
}
