import { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl } from '../lib/helpers';

/**
 * WebRTC hook for receiving audio stream from Android device.
 * 
 * Flow:
 * 1. Call startWebRTC() -> sends webrtc_start command
 * 2. Create RTCPeerConnection and generate offer
 * 3. Send offer via webrtc_offer command
 * 4. Device creates answer, sends back webrtc_answer
 * 5. Exchange ICE candidates
 * 6. Audio track connects and plays
 */

const ICE_SERVERS = [{
  urls: 'stun:stun.l.google.com:19302'
}, {
  urls: 'stun:stun1.l.google.com:19302'
}];
export function useWebRTC() {
  const [stats, setStats] = useState({
    state: 'idle',
    iceState: 'new',
    bitrate: 0,
    packetsLost: 0,
    jitter: 0,
    roundTripTime: 0
  });
  const pcRef = useRef(null);
  const audioRef = useRef(null);
  const sendCommandRef = useRef(null);
  const statsIntervalRef = useRef(null);
  const pendingIceCandidatesRef = useRef([]);
  const offerCreatedRef = useRef(false);
  const offerTimerRef = useRef(null);

  // Create audio element on mount
  useEffect(() => {
    const audio = new Audio();
    audio.autoplay = true;
    audio.volume = 1.0;
    audioRef.current = audio;
    return () => {
      audio.pause();
      audio.srcObject = null;
    };
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (statsIntervalRef.current) {
        clearInterval(statsIntervalRef.current);
      }
      if (offerTimerRef.current) {
        clearTimeout(offerTimerRef.current);
      }
      if (pcRef.current) {
        pcRef.current.close();
      }
    };
  }, []);

  const createAndSendOffer = useCallback((pcOverride = null) => {
    const pc = pcOverride || pcRef.current;
    if (!pc || offerCreatedRef.current) return;

    offerCreatedRef.current = true;
    pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: false
    }).then(offer => {
      return pc.setLocalDescription(offer);
    }).then(() => {
      if (pc.localDescription && sendCommandRef.current) {
        console.log('[WebRTC] Sending offer');
        sendCommandRef.current('webrtc_offer', {
          sdp: pc.localDescription.sdp
        });
      }
    }).catch(err => {
      console.error('[WebRTC] Failed to create offer:', err);
      offerCreatedRef.current = false;
      setStats(prev => ({
        ...prev,
        state: 'failed'
      }));
    });
  }, []);
  const updateStats = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc) return;
    try {
      const reports = await pc.getStats();
      let packetsLost = 0;
      let packetsReceived = 0;
      let jitter = 0;
      let roundTripTime = 0;

      reports.forEach(report => {
        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          packetsLost = report.packetsLost || 0;
          packetsReceived = report.packetsReceived || 0;
          jitter = (report.jitter || 0) * 1000;
        }
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          roundTripTime = (report.currentRoundTripTime || 0) * 1000;
        }
      });

      // Calculate packet loss percentage
      const totalPackets = packetsLost + packetsReceived;
      const lossPct = totalPackets > 0 ? (packetsLost / totalPackets) * 100 : 0;

      setStats(prev => ({
        ...prev,
        packetsLost,
        jitter,
        roundTripTime,
        lossPct: parseFloat(lossPct.toFixed(2))
      }));

      // W-B1 fix: Send quality metrics to backend so Android device can dynamically adapt its bitrate
      // when far from the router (weak WiFi). Without this, the Android app is blind to network lag.
      if (sendCommandRef.current) {
        sendCommandRef.current('webrtc_quality', {
          quality: {
            lossPct: parseFloat(lossPct.toFixed(2)),
            jitterMs: jitter,
            rttMs: roundTripTime
          }
        });
      }
    } catch {
      // Stats not available
    }
  }, []);
  const start = useCallback(async sendCommand => {
    if (pcRef.current) {
      console.log('[WebRTC] Already active, stopping first');
      pcRef.current.close();
    }
    sendCommandRef.current = sendCommand;
    pendingIceCandidatesRef.current = [];
    offerCreatedRef.current = false;
    if (offerTimerRef.current) {
      clearTimeout(offerTimerRef.current);
      offerTimerRef.current = null;
    }
    setStats(prev => ({
      ...prev,
      state: 'connecting'
    }));

    let iceServers = ICE_SERVERS;
    try {
      const res = await fetch(apiUrl('/api/webrtc-config'));
      if (res.ok) {
        const cfg = await res.json();
        if (cfg.iceServers?.length) iceServers = cfg.iceServers;
      }
    } catch {}

    // Create peer connection
    const pc = new RTCPeerConnection({
      iceServers: iceServers,
      iceCandidatePoolSize: 10
    });
    pcRef.current = pc;

    // Tell device to start WebRTC ONLY after PC is ready to receive early ICE candidates
    sendCommand('webrtc_start');

    // Handle ICE candidates
    pc.onicecandidate = event => {
      if (event.candidate && sendCommandRef.current) {
        sendCommandRef.current('webrtc_ice', {
          candidate: {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex
          }
        });
      }
    };
    pc.oniceconnectionstatechange = () => {
      setStats(prev => ({
        ...prev,
        iceState: pc.iceConnectionState
      }));
      switch (pc.iceConnectionState) {
        case 'connected':
        case 'completed':
          setStats(prev => ({
            ...prev,
            state: 'connected'
          }));
          break;
        case 'disconnected':
          setStats(prev => ({
            ...prev,
            state: 'disconnected'
          }));
          break;
        case 'failed':
          setStats(prev => ({
            ...prev,
            state: 'failed'
          }));
          break;
      }
    };
    pc.ontrack = event => {
      console.log('[WebRTC] Received track:', event.track.kind);
      if (event.streams[0]) {
        // SENIOR DEV FIX: Direct hardware playback. 
        // Do NOT route WebRTC through AudioContext. Native `<audio>` playback 
        // is required for the browser's hardware AEC (Acoustic Echo Canceler) to function.
        if (audioRef.current) {
          audioRef.current.srcObject = event.streams[0];
          audioRef.current.muted = false; // Unmute it!
          audioRef.current.volume = 1.0;
          audioRef.current.play().catch(err => console.warn('[WebRTC] Autoplay blocked:', err));
        }
        console.log('[WebRTC] Direct hardware playback active (AEC preserved)');
      }
    };

    // Add transceiver for receiving audio
    pc.addTransceiver('audio', {
      direction: 'recvonly'
    });

    // ACK-driven offer creation is primary. Keep timer only as guard for lost ACKs.
    offerTimerRef.current = window.setTimeout(() => {
      createAndSendOffer(pc);
      offerTimerRef.current = null;
    }, 1500);

    // Start stats monitoring
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
    }
    statsIntervalRef.current = window.setInterval(updateStats, 2000);
  }, [createAndSendOffer, updateStats]);
  const stop = useCallback(sendCommand => {
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }
    if (offerTimerRef.current) {
      clearTimeout(offerTimerRef.current);
      offerTimerRef.current = null;
    }
    offerCreatedRef.current = false;
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.srcObject = null;
    }
    sendCommand('webrtc_stop');
    setStats({
      state: 'idle',
      iceState: 'new',
      bitrate: 0,
      packetsLost: 0,
      jitter: 0,
      roundTripTime: 0
    });
  }, []);
  const handleMessage = useCallback(msg => {
    const type = String(msg.type || '');
    const pc = pcRef.current;
    if (type === 'command_ack') {
      const cmd = String(msg.command || '');
      const status = String(msg.status || 'success');
      if (cmd === 'webrtc_start' && pc) {
        if (status === 'success') {
          if (offerTimerRef.current) {
            clearTimeout(offerTimerRef.current);
            offerTimerRef.current = null;
          }
          createAndSendOffer(pc);
        } else {
          setStats(prev => ({
            ...prev,
            state: 'failed'
          }));
        }
      }
      return;
    }
    if (type === 'webrtc_answer' && pc) {
      const sdp = String(msg.sdp || '');
      if (!sdp) return;
      console.log('[WebRTC] Received answer');
      pc.setRemoteDescription(new RTCSessionDescription({
        type: 'answer',
        sdp: sdp
      })).then(() => {
        // Add any pending ICE candidates
        pendingIceCandidatesRef.current.forEach(candidate => {
          pc.addIceCandidate(candidate).catch(e => console.warn('[WebRTC] Failed to add pending ICE candidate:', e));
        });
        pendingIceCandidatesRef.current = [];
      }).catch(err => {
        console.error('[WebRTC] Failed to set remote description:', err);
        setStats(prev => ({
          ...prev,
          state: 'failed'
        }));
      });
    }
    if (type === 'webrtc_ice' && pc) {
      const candidateData = msg.candidate;
      if (!candidateData) return;
      const candidate = new RTCIceCandidate({
        candidate: String(candidateData.candidate || ''),
        sdpMid: String(candidateData.sdpMid || ''),
        sdpMLineIndex: Number(candidateData.sdpMLineIndex || 0)
      });
      if (pc.remoteDescription) {
        pc.addIceCandidate(candidate).catch(e => console.warn('[WebRTC] Failed to add ICE candidate:', e));
      } else {
        // Queue for later
        pendingIceCandidatesRef.current.push(candidate);
      }
    }
    if (type === 'webrtc_state') {
      console.log('[WebRTC] Device state:', msg);
    }
  }, [createAndSendOffer]);
  return {
    stats,
    start,
    stop,
    handleMessage
  };
}
