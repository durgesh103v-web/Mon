import { useState, useMemo, useCallback, memo } from 'react';

const QUALITY_OPTIONS = [
  { label: 'Standard', value: 'standard', desc: '1280px • JPEG 70-78%' },
  { label: 'Low Data', value: 'low', desc: '720px • JPEG 55-65%' },
  { label: 'HD', value: 'hd', desc: 'Full Res • JPEG 85%' },
];

const NIGHT_MODES = ['off', '1s', '3s', '5s'];
const NIGHT_LABELS = { off: 'Off', '1s': 'Low', '3s': 'Med', '5s': 'High' };

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
}

const PhotoCard = memo(function PhotoCard({ photo, onClick }) {
  return (
    <div className="photo-card" onClick={onClick}>
      <img src={photo.url} alt={photo.filename} loading="lazy" />
      <div className="photo-overlay">
        <div>
          <span style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {photo.camera}
          </span>
          {photo.size > 0 && <span style={{ marginLeft: 6, opacity: 0.7 }}>{formatFileSize(photo.size)}</span>}
        </div>
        <span style={{ opacity: 0.65 }}>{formatTimestamp(photo.timestamp)}</span>
      </div>
    </div>
  );
});

const PhotoModal = memo(function PhotoModal({ photo, onClose }) {
  const [rotation, setRotation] = useState(0);
  if (!photo) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <img
          src={photo.url}
          alt={photo.filename}
          style={{ transform: `rotate(${rotation}deg)`, transition: 'transform 0.3s ease' }}
        />
        {/* Close + Rotate controls */}
        <div style={{
          position: 'absolute', top: 12, right: 12,
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <button onClick={onClose} style={modalBtnStyle} title="Close">✕</button>
          <button onClick={() => setRotation(r => (r + 90) % 360)} style={modalBtnStyle} title="Rotate">↻</button>
          <a
            href={photo.url}
            download={photo.filename || 'photo.jpg'}
            style={modalBtnStyle}
            title="Download"
            onClick={e => e.stopPropagation()}
          >⬇</a>
        </div>
        {/* Info strip */}
        <div style={{
          marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: 8, flexWrap: 'wrap',
        }}>
          <InfoChip label={photo.camera} color="#818cf8" />
          <InfoChip label={photo.quality} color="#22d3ee" />
          {photo.size > 0 && <InfoChip label={formatFileSize(photo.size)} color="#a1a1aa" />}
          {photo.aiEnhanced && <InfoChip label="Enhanced" color="#10b981" />}
          <span style={{ fontSize: 11, color: '#71717a' }}>
            {new Date(photo.timestamp).toLocaleString()}
          </span>
        </div>
      </div>
    </div>
  );
});

const modalBtnStyle = {
  width: 36, height: 36, borderRadius: '50%',
  background: 'rgba(0,0,0,0.65)', border: '1px solid rgba(255,255,255,0.15)',
  color: '#fff', fontSize: 16, cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  backdropFilter: 'blur(8px)', transition: 'background 0.15s',
  textDecoration: 'none',
};

function InfoChip({ label, color }) {
  return (
    <span style={{
      padding: '3px 10px', borderRadius: 20,
      background: `${color}18`, border: `1px solid ${color}35`,
      color, fontSize: 10, fontWeight: 600,
      textTransform: 'uppercase', letterSpacing: '0.06em',
    }}>
      {label}
    </span>
  );
}

export const CameraPanel = memo(function CameraPanel({
  photos,
  onCommand,
  health,
  isConnected = false,
  deviceId,
  pendingCommands = {},
}) {
  const [selectedPhoto, setSelectedPhoto] = useState(null);
  const [photoQuality, setPhotoQuality] = useState('standard');
  const [nightMode, setNightMode] = useState(health?.photoNight || 'off');
  const [lastPhotoCam, setLastPhotoCam] = useState(null);

  const isTakingPhoto = useMemo(() => {
    if (!deviceId) return false;
    const s = pendingCommands[`${deviceId}:take_photo`]?.status;
    return s === 'sending' || s === 'queued';
  }, [deviceId, pendingCommands]);

  const disabledAll = !isConnected || !deviceId;

  const handleCapture = useCallback((cam) => {
    if (disabledAll || isTakingPhoto) return;
    setLastPhotoCam(cam);
    onCommand('take_photo', { camera: cam, quality: photoQuality });
  }, [disabledAll, isTakingPhoto, onCommand, photoQuality]);

  const cycleNight = useCallback(() => {
    const next = NIGHT_MODES[(NIGHT_MODES.indexOf(nightMode) + 1) % NIGHT_MODES.length];
    setNightMode(next);
    onCommand('photo_night', { mode: next });
  }, [nightMode, onCommand]);

  const handleQualityChange = useCallback((q) => {
    setPhotoQuality(q);
    onCommand('photo_quality', { quality: q });
  }, [onCommand]);

  const captureStatus = useMemo(() => {
    if (!deviceId) return null;
    return pendingCommands[`${deviceId}:take_photo`]?.status || null;
  }, [deviceId, pendingCommands]);

  return (
    <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: 'rgba(99,102,241,0.06)', borderBottom: '1px solid rgba(99,102,241,0.12)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16 }}>📷</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#e4e4e7', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Camera
          </span>
          <span style={{ fontSize: 10, color: '#52525b', fontWeight: 500 }}>
            {photos.length} photos
          </span>
        </div>
        {/* Upload status indicator */}
        {captureStatus && (
          <CaptureStatusBadge status={captureStatus} camera={lastPhotoCam} />
        )}
      </div>

      {/* Controls row */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(63,63,70,0.3)' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {/* Capture buttons */}
          <CaptureBtn
            icon="📷" label="Front"
            onClick={() => handleCapture('front')}
            disabled={disabledAll || isTakingPhoto}
            active={isTakingPhoto && lastPhotoCam === 'front'}
            color="#818cf8"
          />
          <CaptureBtn
            icon="📷" label="Rear"
            onClick={() => handleCapture('rear')}
            disabled={disabledAll || isTakingPhoto}
            active={isTakingPhoto && lastPhotoCam === 'rear'}
            color="#38bdf8"
          />

          <div style={{ width: 1, height: 28, background: 'rgba(63,63,70,0.4)', margin: '0 4px' }} />

          {/* Quality selector */}
          <div style={{ display: 'flex', gap: 4 }}>
            {QUALITY_OPTIONS.map(q => (
              <button
                key={q.value}
                onClick={() => handleQualityChange(q.value)}
                disabled={disabledAll}
                title={q.desc}
                style={{
                  padding: '5px 10px', borderRadius: 8, fontSize: 10,
                  fontWeight: 600, cursor: disabledAll ? 'not-allowed' : 'pointer',
                  background: photoQuality === q.value ? 'rgba(99,102,241,0.2)' : 'rgba(39,39,42,0.5)',
                  border: `1px solid ${photoQuality === q.value ? 'rgba(99,102,241,0.45)' : 'rgba(63,63,70,0.4)'}`,
                  color: photoQuality === q.value ? '#a5b4fc' : '#71717a',
                  transition: 'all 0.15s',
                  opacity: disabledAll ? 0.5 : 1,
                }}
              >
                {q.label}
              </button>
            ))}
          </div>

          <div style={{ width: 1, height: 28, background: 'rgba(63,63,70,0.4)', margin: '0 4px' }} />

          {/* Night toggle */}
          <button
            onClick={cycleNight}
            disabled={disabledAll}
            title={`Night enhance: ${NIGHT_LABELS[nightMode]}`}
            style={{
              padding: '5px 12px', borderRadius: 8, fontSize: 10,
              fontWeight: 600, cursor: disabledAll ? 'not-allowed' : 'pointer',
              background: nightMode !== 'off' ? 'rgba(168,85,247,0.15)' : 'rgba(39,39,42,0.5)',
              border: `1px solid ${nightMode !== 'off' ? 'rgba(168,85,247,0.4)' : 'rgba(63,63,70,0.4)'}`,
              color: nightMode !== 'off' ? '#c084fc' : '#71717a',
              transition: 'all 0.15s', display: 'flex', alignItems: 'center', gap: 4,
              opacity: disabledAll ? 0.5 : 1,
            }}
          >
            🌙 Night: {NIGHT_LABELS[nightMode]}
          </button>
        </div>
      </div>

      {/* Photo Gallery */}
      <div style={{ padding: 12 }}>
        {photos.length > 0 ? (
          <div className="photo-grid">
            {photos.slice(0, 20).map(photo => (
              <PhotoCard
                key={photo.id}
                photo={photo}
                onClick={() => setSelectedPhoto(photo)}
              />
            ))}
          </div>
        ) : (
          <div style={{
            padding: '40px 16px', textAlign: 'center',
            color: '#52525b', fontSize: 13,
          }}>
            <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.3 }}>📷</div>
            <div style={{ fontWeight: 500 }}>No photos yet</div>
            <div style={{ fontSize: 11, marginTop: 4, opacity: 0.7 }}>
              Tap Front or Rear to capture
            </div>
          </div>
        )}
      </div>

      <PhotoModal photo={selectedPhoto} onClose={() => setSelectedPhoto(null)} />
    </div>
  );
});

function CaptureBtn({ icon, label, onClick, disabled, active, color }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '6px 14px', borderRadius: 10, fontSize: 11,
        fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer',
        background: active ? `${color}25` : 'rgba(39,39,42,0.6)',
        border: `1px solid ${active ? `${color}55` : 'rgba(63,63,70,0.5)'}`,
        color: active ? color : '#a1a1aa',
        transition: 'all 0.2s', display: 'flex', alignItems: 'center', gap: 5,
        opacity: disabled ? 0.5 : 1,
        textTransform: 'uppercase', letterSpacing: '0.05em',
      }}
    >
      <span>{icon}</span> {active ? 'Capturing...' : label}
    </button>
  );
}

function CaptureStatusBadge({ status, camera }) {
  const normalized = status === 'sending' || status === 'queued' ? 'pending'
    : status === 'success' ? 'done' : status;
  const meta = {
    pending: { label: 'Uploading...', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
    sent: { label: 'Sent', color: '#34d399', bg: 'rgba(16,185,129,0.12)' },
    done: { label: 'Done', color: '#34d399', bg: 'rgba(16,185,129,0.12)' },
    error: { label: 'Failed', color: '#f87171', bg: 'rgba(239,68,68,0.12)' },
  }[normalized];
  if (!meta) return null;
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, padding: '3px 8px', borderRadius: 12,
      background: meta.bg, border: `1px solid ${meta.color}35`,
      color: meta.color, textTransform: 'uppercase', letterSpacing: '0.06em',
      display: 'flex', alignItems: 'center', gap: 4,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: meta.color }} />
      {camera && <span>{camera}</span>}
      {meta.label}
    </span>
  );
}
