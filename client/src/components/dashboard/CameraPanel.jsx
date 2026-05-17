import { useState, useMemo, useCallback, memo } from 'react';

const QUALITY_OPTIONS = [
  { label: 'Standard', value: 'normal', desc: '1280px, JPEG 70-78%' },
  { label: 'Low Data', value: 'fast', desc: '720px, JPEG 55-65%' },
  { label: 'HD', value: 'hd', desc: 'Optional HD capture' },
];

function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return 'Size pending';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(ts) {
  if (!ts) return 'Time pending';
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

const PhotoCard = memo(function PhotoCard({ photo, active, onClick }) {
  return (
    <button className={`photo-card ${active ? 'is-active' : ''}`} onClick={onClick} type="button">
      <img src={photo.url} alt={photo.filename || `${photo.camera} capture`} loading="lazy" />
      <span className="photo-kind">{photo.camera}</span>
      <div className="photo-overlay">
        <span>{formatTimestamp(photo.timestamp)}</span>
        <span>{photo.quality || 'normal'}</span>
      </div>
    </button>
  );
});

const PhotoPreview = memo(function PhotoPreview({ photo, onClose }) {
  const [dimensions, setDimensions] = useState('');
  if (!photo) return null;

  return (
    <aside className="photo-preview" aria-label="Photo preview">
      <div className="photo-preview-head">
        <div>
          <div className="eyebrow">Preview</div>
          <h3>{photo.camera === 'screenshot' ? 'Screenshot' : `${photo.camera} camera`}</h3>
        </div>
        <button className="icon-button" onClick={onClose} type="button" title="Close preview">x</button>
      </div>

      <div className="photo-preview-frame">
        <img
          src={photo.url}
          alt={photo.filename || 'Captured photo preview'}
          onLoad={event => {
            const img = event.currentTarget;
            setDimensions(`${img.naturalWidth} x ${img.naturalHeight}`);
          }}
        />
      </div>

      <div className="photo-meta-grid">
        <InfoCell label="Camera" value={photo.camera} />
        <InfoCell label="Time" value={formatTimestamp(photo.timestamp)} />
        <InfoCell label="Quality" value={photo.quality || 'normal'} />
        <InfoCell label="Image Size" value={dimensions || formatFileSize(photo.size)} />
        <InfoCell label="Upload" value={formatFileSize(photo.size)} />
        <InfoCell label="File" value={photo.filename || 'photo.jpg'} mono />
      </div>
    </aside>
  );
});

function InfoCell({ label, value, mono = false }) {
  return (
    <div className="photo-meta-cell">
      <span>{label}</span>
      <strong className={mono ? 'mono-value' : ''}>{value}</strong>
    </div>
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
  const [photoQuality, setPhotoQuality] = useState(health?.photoQuality || 'normal');
  const [nightEnhance, setNightEnhance] = useState(health?.photoNight && health.photoNight !== 'off');
  const [lastCaptureType, setLastCaptureType] = useState(null);

  const statusFor = useCallback((cmd) => {
    if (!deviceId) return null;
    return pendingCommands[`${deviceId}:${cmd}`]?.status || null;
  }, [deviceId, pendingCommands]);

  const isPhotoPending = useMemo(() => {
    const s = statusFor('take_photo');
    return s === 'sending' || s === 'queued';
  }, [statusFor]);

  const isScreenshotPending = useMemo(() => {
    const s = statusFor('take_screenshot');
    return s === 'sending' || s === 'queued';
  }, [statusFor]);

  const disabledAll = !isConnected || !deviceId;
  const uploadStatus = isPhotoPending || isScreenshotPending
    ? `${lastCaptureType || 'Capture'} uploading`
    : disabledAll
      ? 'Offline'
      : 'Ready';

  const handleCapture = useCallback((camera) => {
    if (disabledAll || isPhotoPending || isScreenshotPending) return;
    setLastCaptureType(camera);
    onCommand('photo_quality', { mode: photoQuality });
    onCommand('take_photo', { camera, mode: photoQuality });
  }, [disabledAll, isPhotoPending, isScreenshotPending, onCommand, photoQuality]);

  const handleScreenshot = useCallback(() => {
    if (disabledAll || isPhotoPending || isScreenshotPending) return;
    setLastCaptureType('screenshot');
    onCommand('take_screenshot');
  }, [disabledAll, isPhotoPending, isScreenshotPending, onCommand]);

  const handleQualityChange = useCallback((mode) => {
    setPhotoQuality(mode);
    onCommand('photo_quality', { mode });
  }, [onCommand]);

  const toggleNight = useCallback(() => {
    const enabled = !nightEnhance;
    setNightEnhance(enabled);
    onCommand('photo_night', { mode: enabled ? '1s' : 'off' });
  }, [nightEnhance, onCommand]);

  return (
    <section className="camera-workspace">
      <div className="panel-shell camera-controls">
        <div className="panel-title-row">
          <div>
            <div className="eyebrow">Camera Controls</div>
            <h2>Still Capture</h2>
          </div>
          <span className={`status-pill ${disabledAll ? 'bad' : 'good'}`}>{uploadStatus}</span>
        </div>

        <div className="camera-action-grid">
          <CaptureButton label="Front Capture" onClick={() => handleCapture('front')} disabled={disabledAll || isPhotoPending || isScreenshotPending} active={isPhotoPending && lastCaptureType === 'front'} />
          <CaptureButton label="Rear Capture" onClick={() => handleCapture('rear')} disabled={disabledAll || isPhotoPending || isScreenshotPending} active={isPhotoPending && lastCaptureType === 'rear'} />
          <CaptureButton label="Screenshot" onClick={handleScreenshot} disabled={disabledAll || isPhotoPending || isScreenshotPending} active={isScreenshotPending} />
        </div>

        <div className="control-block">
          <div className="control-label">Quality Selector</div>
          <div className="segmented-control">
            {QUALITY_OPTIONS.map(option => (
              <button
                key={option.value}
                type="button"
                onClick={() => handleQualityChange(option.value)}
                disabled={disabledAll}
                title={option.desc}
                className={photoQuality === option.value ? 'is-selected' : ''}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="camera-toggle-row">
          <button
            type="button"
            className={`toggle-row ${nightEnhance ? 'is-on' : ''}`}
            onClick={toggleNight}
            disabled={disabledAll}
          >
            <span>Night Enhance</span>
            <strong>{nightEnhance ? 'On' : 'Off'}</strong>
          </button>
          <div className="upload-status-card">
            <span>Upload Status</span>
            <strong>{uploadStatus}</strong>
          </div>
        </div>
      </div>

      <div className="panel-shell gallery-panel">
        <div className="panel-title-row">
          <div>
            <div className="eyebrow">Captured Photo Gallery</div>
            <h2>{photos.length} Items</h2>
          </div>
          <span className="status-pill">Latest first</span>
        </div>

        {photos.length > 0 ? (
          <div className="photo-grid">
            {photos.slice(0, 24).map(photo => (
              <PhotoCard
                key={photo.id}
                photo={photo}
                active={selectedPhoto?.id === photo.id}
                onClick={() => setSelectedPhoto(photo)}
              />
            ))}
          </div>
        ) : (
          <div className="empty-gallery">
            <strong>No captures yet</strong>
            <span>Use Front Capture, Rear Capture, or Screenshot.</span>
          </div>
        )}
      </div>

      <PhotoPreview photo={selectedPhoto} onClose={() => setSelectedPhoto(null)} />
    </section>
  );
});

function CaptureButton({ label, onClick, disabled, active }) {
  return (
    <button
      className={`capture-button ${active ? 'is-active' : ''}`}
      type="button"
      onClick={onClick}
      disabled={disabled}
    >
      <span>{active ? 'Working' : label}</span>
    </button>
  );
}
