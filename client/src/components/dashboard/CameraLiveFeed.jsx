import { useState } from 'react';
export function CameraLiveFeed({
  frame,
  photos,
  onTakeFront,
  onTakeRear,
  onStopLive
}) {
  const [selectedPhoto, setSelectedPhoto] = useState(null);
  const [rotation, setRotation] = useState(0);
  const [modalRotation, setModalRotation] = useState(0);
  return <div className="rounded-lg border border-slate-700/50 bg-slate-800/30 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 bg-blue-500/20 border-b border-slate-700/50">
        <div className="flex items-center gap-2">
          <span className="text-blue-400">📹</span>
          <span className="text-sm font-medium text-white">Camera</span>
          {frame && <span className="px-1.5 py-0.5 text-[9px] bg-red-500/30 text-red-400 rounded animate-pulse">
              LIVE
            </span>}
        </div>
        {frame && <div className="flex items-center gap-2">
            <button onClick={onTakeFront} className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors">
              📷 Front
            </button>
            <button onClick={onTakeRear} className="px-2 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded transition-colors">
              📷 Rear
            </button>
            <button onClick={() => setRotation(r => (r + 90) % 360)} className="px-2 py-1 text-xs bg-slate-600 hover:bg-slate-500 text-white rounded transition-colors" title="Rotate 90°">
              ↻
            </button>
            <button onClick={onStopLive} className="px-2 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors">
              ⏹ Stop
            </button>
          </div>}
      </div>

      <div className="p-2">
        {/* Live Feed */}
        {frame ? <div className="relative">
            <div className="w-full h-48 bg-black rounded overflow-hidden flex items-center justify-center">
              <img src={frame.url || `data:${frame.mime};base64,${frame.data}`} alt="Live camera feed" className="max-w-full max-h-full object-contain transition-transform" style={{
            transform: `rotate(${rotation}deg)`
          }} />
            </div>
            <div className="absolute bottom-2 left-2 flex items-center gap-2 z-10">
              <span className="px-1.5 py-0.5 text-[9px] bg-black/70 text-white rounded">
                {frame.camera.toUpperCase()}
              </span>
              <span className="px-1.5 py-0.5 text-[9px] bg-black/70 text-white rounded">
                {frame.quality}
              </span>
            </div>
          </div> : <div className="h-32 flex items-center justify-center text-slate-500 text-sm">
            Click "Live Video" to start camera stream
          </div>}

        {/* Photo Gallery */}
        {photos.length > 0 && <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">
              Recent Photos ({photos.length})
            </div>
            <div className="flex flex-row overflow-x-auto gap-3 pb-2 horizontal-scrollbar">
              {photos.slice(0, 8).map(photo => <div key={photo.id} className="relative cursor-pointer group flex-shrink-0" onClick={() => {
            setSelectedPhoto(photo);
            setModalRotation(0);
          }}>
                  <img src={photo.url} alt={photo.filename} className="w-32 h-24 object-cover rounded border border-slate-700 group-hover:border-blue-500 transition-colors" />
                  <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-[8px] text-white px-1 py-0.5 truncate">
                    {photo.camera} • {photo.quality}
                  </div>
                </div>)}
            </div>
          </div>}
      </div>

      {/* Photo Modal */}
      {selectedPhoto && <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50" onClick={() => setSelectedPhoto(null)}>
          <div className="max-w-4xl max-h-[90vh] relative" onClick={e => e.stopPropagation()}>
            <img src={selectedPhoto.url} alt={selectedPhoto.filename} className="max-w-full max-h-[80vh] object-contain rounded-lg transition-transform" style={{
          transform: `rotate(${modalRotation}deg)`
        }} />
            <div className="absolute top-2 right-2 flex flex-col gap-2">
              <button onClick={() => setSelectedPhoto(null)} className="w-8 h-8 bg-black/60 hover:bg-black/80 text-white rounded-full text-xl flex items-center justify-center transition-colors" title="Close">
                ×
              </button>
              <button onClick={() => setModalRotation(r => (r + 90) % 360)} className="w-8 h-8 bg-black/60 hover:bg-black/80 text-white rounded-full text-lg flex items-center justify-center transition-colors" title="Rotate 90°">
                ↻
              </button>
            </div>
            <div className="mt-2 text-center text-white text-sm">
              <span className="px-2 py-1 bg-slate-800 rounded mr-2">{selectedPhoto.camera}</span>
              <span className="px-2 py-1 bg-slate-800 rounded mr-2">{selectedPhoto.quality}</span>
              {selectedPhoto.aiEnhanced && <span className="px-2 py-1 bg-teal-800 rounded mr-2">AI Enhanced</span>}
              <span className="text-slate-400">
                {new Date(selectedPhoto.timestamp).toLocaleString()}
              </span>
            </div>
          </div>
        </div>}
    </div>;
}
