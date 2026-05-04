export function DeviceFleetList({
  devices,
  selectedDeviceId,
  setSelectedDeviceId,
  onCommand,
  pendingCommands = {}
}) {
  if (devices.length === 0) return null;
  return <div className="mb-6">
      <div className="text-[10px] uppercase tracking-widest font-bold text-indigo-400 mb-4 flex items-center gap-2">
        <span className="flex-1 h-px" style={{
        background: 'linear-gradient(90deg, rgba(34,211,238,0.5), transparent)'
      }} />
        Device Fleet
        <span className="flex-1 h-px" style={{
        background: 'linear-gradient(90deg, transparent, rgba(34,211,238,0.5))'
      }} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {devices.map(device => {
        const isSelected = selectedDeviceId === device.deviceId;
        const health = device.health || {};
        const isOffline = health.wsConnected === false;

        // Check if a wake command is currently firing for this specific device
        const isWaking = pendingCommands[`${device.deviceId}:wake_device`]?.status === 'sending';
        return <div key={device.deviceId} onClick={() => setSelectedDeviceId(device.deviceId)} className={`relative p-4 rounded-xl transition-all duration-300 cursor-pointer overflow-hidden flex flex-col justify-between gap-4 ${isOffline ? 'opacity-80 grayscale-[0.3]' : ''}`} style={{
          background: isSelected ? 'linear-gradient(140deg, rgba(14,165,233,0.2), rgba(34,197,94,0.14))' : 'linear-gradient(165deg, rgba(15,23,42,0.7), rgba(10,16,29,0.62))',
          border: `1px solid ${isSelected ? 'rgba(34,211,238,0.5)' : 'rgba(148,163,184,0.16)'}`,
          boxShadow: isSelected ? '0 0 22px rgba(34,211,238,0.18)' : '0 8px 16px rgba(0,0,0,0.24)'
        }}>
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full flex items-center justify-center text-xl shrink-0" style={{
              background: 'rgba(15,23,42,0.75)',
              border: '1px solid rgba(71,85,105,0.55)'
            }}>
                  {isOffline ? '💤' : '📱'}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-slate-100 truncate">
                    {device.model || 'Unknown Device'}
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono mt-0.5 truncate">
                    {device.deviceId}
                  </div>
                  <div className="flex items-center gap-3 mt-2">
                    <StatusDot active={!isOffline} label={isOffline ? 'Offline' : 'Online'} />
                    {health.batteryPct != null && <span className="text-[10px] text-slate-400 font-medium">🔋 {health.batteryPct}%</span>}
                  </div>
                </div>
              </div>

              {/* Inline Wake Button for Offline Devices */}
              {isOffline && onCommand && <div className="mt-2 pt-3 border-t border-slate-700/50">
                  <button onClick={e => {
              e.stopPropagation();
              setSelectedDeviceId(device.deviceId);
              onCommand('wake_device');
            }} disabled={isWaking} className="w-full py-2 rounded-lg bg-amber-500/10 text-amber-500 border border-amber-500/30 text-[10px] font-bold hover:bg-amber-500/20 transition-all uppercase tracking-wider disabled:opacity-50">
                    {isWaking ? '⚡ WAKING...' : '⚡ FORCE WAKE'}
                  </button>
                </div>}

              {isSelected && <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-cyan-400 to-emerald-400" />}
            </div>;
      })}
      </div>
    </div>;
}
function StatusDot({
  active,
  label
}) {
  return <div className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${active ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
      <span className="text-[10px] text-slate-400 uppercase tracking-widest">{label}</span>
    </div>;
}