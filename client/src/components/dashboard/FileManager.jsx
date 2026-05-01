import React, { useState, useEffect, useCallback, useRef } from 'react';
import { apiUrl } from '../../lib/helpers';

const pathStorageKey = deviceId => `micmonitor:fileManagerPath:${deviceId}`;

// Helper: Format bytes to human readable string
const formatBytes = (bytes, decimals = 2) => {
  if (!+bytes) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

// Helper: Format timestamp
const formatDate = (ts) => {
  if (!ts) return 'Unknown';
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

const extensionOf = name => String(name || '').split('.').pop()?.toLowerCase() || '';

const fileIconFor = item => {
  if (item.isDir) return '📁';
  const ext = extensionOf(item.name);
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp', 'svg'].includes(ext)) return '🖼️';
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'amr', 'opus'].includes(ext)) return '🎵';
  if (['mp4', 'mkv', '3gp', 'webm', 'avi', 'mov'].includes(ext)) return '🎬';
  if (ext === 'pdf') return '📕';
  if (['doc', 'docx', 'rtf', 'odt'].includes(ext)) return '📝';
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return '📊';
  if (['ppt', 'pptx', 'odp'].includes(ext)) return '📽️';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'apk'].includes(ext)) return '📦';
  return '📄';
};

export function FileManager({
  deviceId,
  isConnected,
  onCommand,
  fileManagerData,
  pendingCommands
}) {
  const [currentPath, setCurrentPath] = useState(() => {
    try {
      return window.localStorage.getItem(pathStorageKey(deviceId)) || '/storage/emulated/0/';
    } catch {
      return '/storage/emulated/0/';
    }
  });
  const [history, setHistory] = useState([]);
  const [items, setItems] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  
  // Dialog state
  const [dialogState, setDialogState] = useState({ open: false, type: null, item: null, input: '' });
  
  // Refs for tracking mutable transfer state
  const pendingPathRef = useRef(null);
  const currentPathRef = useRef(currentPath);

  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  // Request files for a path
  const loadPath = useCallback((path) => {
    if (!deviceId || !isConnected) return;
    setIsLoading(true);
    setError(null);
    pendingPathRef.current = path;
    onCommand('list_files', { path });
  }, [deviceId, isConnected, onCommand]);

  useEffect(() => {
    let nextPath = '/storage/emulated/0/';
    try {
      const saved = window.localStorage.getItem(pathStorageKey(deviceId));
      nextPath = saved || nextPath;
    } catch {
      nextPath = '/storage/emulated/0/';
    }
    setCurrentPath(nextPath);
    currentPathRef.current = nextPath;
    setHistory([]);
    setItems([]);
    pendingPathRef.current = null;
    if (deviceId && isConnected) {
      loadPath(nextPath);
    }
  }, [deviceId, isConnected, loadPath]);

  // Handle incoming data
  useEffect(() => {
    if (!fileManagerData || fileManagerData.deviceId !== deviceId) return;

    const { action, status, error: resultError } = fileManagerData;

    if (status === 'error') {
      setError(resultError || 'Unknown error occurred');
      setIsLoading(false);
      return;
    }

    if (action === 'list_files') {
      const newPath = fileManagerData.path || '/';
      setItems(fileManagerData.items || []);
      try {
        window.localStorage.setItem(pathStorageKey(deviceId), newPath);
      } catch {
        // Storage is best-effort only.
      }
      
      if (currentPath !== newPath && !history.includes(newPath)) {
         if (pendingPathRef.current === newPath) {
           setHistory(prev => [...prev, currentPath]);
         }
      }
      
      setCurrentPath(newPath);
      setIsLoading(false);
      pendingPathRef.current = null;
    }
    else if (['delete_file', 'rename_file', 'create_dir'].includes(action)) {
      loadPath(currentPath);
      closeDialog();
    }
  }, [fileManagerData, deviceId, currentPath, loadPath, history]);

  // Navigation handlers
  const handleNavigate = (path) => {
    loadPath(path);
  };

  const handleNavigateUp = () => {
    if (currentPath === '/') return;
    const parent = currentPath.replace(/\/$/, '').split('/').slice(0, -1).join('/') || '/';
    if (history.length > 0) {
      setHistory(prev => prev.slice(0, -1));
    }
    loadPath(parent);
  };

  // Action handlers
  const buildFileUrl = (item, mode = 'open') => {
    if (!item?.path || !deviceId) {
      setError('Missing device or file path. Refresh the list and try again.');
      return null;
    }
    const encodedPath = encodeURIComponent(item.path);
    let url = apiUrl(`/file?deviceId=${encodeURIComponent(deviceId)}&path=${encodedPath}`);
    const token = import.meta.env.VITE_WS_AUTH_TOKEN;
    if (token) {
      const urlObj = new URL(url, window.location.origin);
      urlObj.searchParams.set('token', token);
      if (mode === 'download') urlObj.searchParams.set('download', '1');
      url = urlObj.toString();
    } else if (mode === 'download') {
      const urlObj = new URL(url, window.location.origin);
      urlObj.searchParams.set('download', '1');
      url = urlObj.toString();
    }
    return url;
  };

  const handleOpenFile = (item, mode = 'open') => {
    const url = buildFileUrl(item, mode);
    if (!url) return;
    const link = document.createElement('a');
    link.href = url;
    if (mode === 'download') {
      link.download = item?.name || 'download';
    } else {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const executeAction = () => {
    const { type, item, input } = dialogState;
    setIsLoading(true);
    setError(null);
    
    if (type === 'delete') {
      onCommand('delete_file', { path: item.path });
    } else if (type === 'rename') {
      if (!input.trim()) return;
      const newPath = currentPath.replace(/\/?$/, '/') + input.trim();
      onCommand('rename_file', { oldPath: item.path, newPath });
    } else if (type === 'mkdir') {
      if (!input.trim()) return;
      const newPath = currentPath.replace(/\/?$/, '/') + input.trim();
      onCommand('create_dir', { path: newPath });
    }
  };

  // Dialog helpers
  const openDialog = (type, item = null) => {
    setDialogState({ 
      open: true, 
      type, 
      item, 
      input: item ? item.name : '' 
    });
  };

  const closeDialog = () => {
    setDialogState({ open: false, type: null, item: null, input: '' });
  };

  // Render components
  const renderBreadcrumbs = () => {
    const parts = currentPath.split('/').filter(Boolean);
    let buildPath = '';
    
    return (
      <div className="flex items-center flex-wrap gap-1 text-sm font-mono p-2 bg-zinc-900/50 rounded-lg border border-zinc-800">
        <button 
          onClick={() => handleNavigate('/')}
          className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-zinc-100 transition-colors"
          title="Root Directory"
        >
          🏠
        </button>
        <span className="text-zinc-600">/</span>
        
        {parts.map((part, i) => {
          buildPath += `/${part}`;
          const isLast = i === parts.length - 1;
          const targetPath = buildPath;
          
          return (
            <React.Fragment key={buildPath}>
              <button
                onClick={() => handleNavigate(targetPath)}
                className={`px-1.5 py-0.5 rounded transition-colors ${
                  isLast 
                    ? 'text-cyan-400 font-semibold bg-cyan-900/20' 
                    : 'text-zinc-300 hover:bg-zinc-800 hover:text-white'
                }`}
              >
                {part}
              </button>
              {!isLast && <span className="text-zinc-600">/</span>}
            </React.Fragment>
          );
        })}
      </div>
    );
  };

  if (!deviceId) return null;

  return (
    <div className="flex flex-col h-[600px] bg-zinc-950 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl relative">
      {/* HEADER */}
      <div className="flex items-center justify-between p-3 border-b border-zinc-800 bg-zinc-900/40">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-cyan-950 border border-cyan-800/50 flex items-center justify-center text-cyan-400 text-lg">
            📁
          </div>
          <div>
            <h3 className="font-bold text-zinc-100 leading-tight">File Manager</h3>
            <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-semibold">Remote Device Storage</p>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <button 
            onClick={() => openDialog('mkdir')}
            className="p-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg transition-colors border border-zinc-700/50"
            title="New Folder"
            disabled={isLoading}
          >
            📁+
          </button>
          <button 
            onClick={() => loadPath(currentPath)}
            className={`p-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg transition-colors border border-zinc-700/50 ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
            title="Refresh"
            disabled={isLoading}
          >
            🔄
          </button>
        </div>
      </div>

      {/* ERROR BANNER */}
      {error && (
        <div className="bg-red-950/50 border-b border-red-900/50 p-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-red-400 text-sm font-semibold">
            <span>⚠️</span> {error}
          </div>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-300">✖</button>
        </div>
      )}

      {/* MAIN CONTENT AREA */}
      <div className="flex-1 overflow-hidden flex flex-col relative">
        {/* Loading Overlay */}
        {isLoading && (
          <div className="absolute inset-0 z-10 bg-zinc-950/50 backdrop-blur-sm flex items-center justify-center">
            <div className="bg-zinc-900 border border-zinc-800 p-4 rounded-xl shadow-2xl flex items-center gap-3">
              <span className="w-5 h-5 rounded-full border-2 border-cyan-500 border-t-transparent animate-spin" />
              <span className="text-zinc-300 font-semibold text-sm tracking-wide">Processing...</span>
            </div>
          </div>
        )}

        <div className="flex flex-col h-full">
          <div className="p-2 border-b border-zinc-800/50 bg-zinc-900/20">
            {renderBreadcrumbs()}
          </div>
          
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 bg-zinc-900/90 backdrop-blur-md border-b border-zinc-800 z-10 text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3 w-10">Type</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3 w-28 text-right">Size</th>
                  <th className="px-4 py-3 w-40">Modified</th>
                  <th className="px-4 py-3 w-24 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="text-sm divide-y divide-zinc-800/50">
                {/* Up directory row */}
                {currentPath !== '/' && (
                  <tr 
                    className="hover:bg-zinc-800/50 cursor-pointer transition-colors group"
                    onClick={handleNavigateUp}
                  >
                    <td className="px-4 py-2 text-xl opacity-70 group-hover:opacity-100">📁</td>
                    <td className="px-4 py-2 font-mono font-bold text-zinc-300 group-hover:text-cyan-400">..</td>
                    <td className="px-4 py-2 text-right text-zinc-600">—</td>
                    <td className="px-4 py-2 text-zinc-600">—</td>
                    <td className="px-4 py-2"></td>
                  </tr>
                )}
                
                {/* File items */}
                {items.length === 0 ? (
                  <tr>
                    <td colSpan="5" className="px-4 py-12 text-center text-zinc-500">
                      {isLoading ? 'Loading...' : 'Empty directory'}
                    </td>
                  </tr>
                ) : (
                  items.map((item, idx) => (
                    <tr 
                      key={idx} 
                      className={`hover:bg-zinc-800/50 transition-colors group ${!item.canRead ? 'opacity-50' : ''}`}
                    >
                      <td 
                        className="px-4 py-2 text-xl cursor-pointer" 
                        onClick={() => {
                          if (!item.canRead) return;
                          if (item.isDir) handleNavigate(item.path);
                          else handleOpenFile(item, 'open');
                        }}
                      >
                        {fileIconFor(item)}
                      </td>
                      <td 
                        className={`px-4 py-2 cursor-pointer font-medium truncate max-w-[200px] ${item.isDir ? 'text-zinc-200' : 'text-zinc-400'}`}
                        onClick={() => {
                          if (!item.canRead) return;
                          if (item.isDir) handleNavigate(item.path);
                          else handleOpenFile(item, 'open');
                        }}
                        title={item.name}
                      >
                        <span className="group-hover:text-cyan-400 transition-colors">
                          {item.name}
                        </span>
                        {!item.canRead && <span className="ml-2 text-[10px] bg-red-900/30 text-red-400 px-1.5 py-0.5 rounded border border-red-800/50">NO READ</span>}
                      </td>
                      <td className="px-4 py-2 text-right text-zinc-500 font-mono text-xs">
                        {item.isDir ? (
                          <span className="bg-zinc-800 px-1.5 py-0.5 rounded">{item.childCount} items</span>
                        ) : (
                          formatBytes(item.size)
                        )}
                      </td>
                      <td className="px-4 py-2 text-zinc-500 text-xs">
                        {formatDate(item.lastModified)}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          {!item.isDir && (
                            <button 
                              onClick={(e) => { e.stopPropagation(); handleOpenFile(item, 'open'); }}
                              className="p-1.5 bg-zinc-800 hover:bg-cyan-900/50 text-zinc-300 hover:text-cyan-400 rounded transition-colors"
                              title="Open in new tab"
                            >
                              🔗
                            </button>
                          )}
                          {!item.isDir && (
                            <button 
                              onClick={(e) => { e.stopPropagation(); handleOpenFile(item, 'download'); }}
                              className="p-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors"
                              title="Download"
                            >
                              ⬇️
                            </button>
                          )}
                          <button 
                            onClick={(e) => { e.stopPropagation(); openDialog('rename', item); }}
                            className="p-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors"
                            title="Rename"
                          >
                            📝
                          </button>
                          <button 
                            onClick={(e) => { e.stopPropagation(); openDialog('delete', item); }}
                            className="p-1.5 bg-red-950/30 hover:bg-red-900/50 text-red-400 rounded transition-colors border border-transparent hover:border-red-800/50"
                            title="Delete"
                          >
                            🗑️
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* DIALOG MODALS */}
      {dialogState.open && (
        <div className="absolute inset-0 z-50 bg-zinc-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden">
            <div className="p-4 border-b border-zinc-800 flex items-center gap-3">
              <span className="text-xl">
                {dialogState.type === 'delete' ? '🗑️' : dialogState.type === 'rename' ? '📝' : '📁'}
              </span>
              <h3 className="font-bold text-zinc-100">
                {dialogState.type === 'delete' ? 'Confirm Deletion' : 
                 dialogState.type === 'rename' ? 'Rename Item' : 
                 'Create Directory'}
              </h3>
            </div>
            
            <div className="p-5">
              {dialogState.type === 'delete' ? (
                <div>
                  <p className="text-sm text-zinc-300 mb-2">Are you sure you want to delete this {dialogState.item?.isDir ? 'directory' : 'file'}?</p>
                  <p className="text-sm font-mono font-bold text-red-400 break-words bg-red-950/30 p-2 rounded border border-red-900/50">
                    {dialogState.item?.name}
                  </p>
                  {dialogState.item?.isDir && (
                    <p className="text-xs text-red-500 mt-2 font-semibold">⚠️ All contents will be permanently deleted!</p>
                  )}
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                    {dialogState.type === 'rename' ? 'New Name' : 'Directory Name'}
                  </label>
                  <input
                    type="text"
                    value={dialogState.input}
                    onChange={(e) => setDialogState(prev => ({...prev, input: e.target.value}))}
                    className="w-full bg-zinc-950 border border-zinc-700 rounded-lg p-2.5 text-zinc-100 text-sm focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/50 transition-all font-mono"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') executeAction();
                      if (e.key === 'Escape') closeDialog();
                    }}
                  />
                </div>
              )}
            </div>
            
            <div className="p-3 bg-zinc-800/30 border-t border-zinc-800 flex items-center justify-end gap-2">
              <button
                onClick={closeDialog}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                disabled={isLoading}
              >
                Cancel
              </button>
              <button
                onClick={executeAction}
                className={`px-4 py-2 rounded-lg text-sm font-bold transition-all shadow-lg ${
                  dialogState.type === 'delete'
                    ? 'bg-red-600 hover:bg-red-500 text-white border border-red-500/50 shadow-red-900/20'
                    : 'bg-cyan-600 hover:bg-cyan-500 text-white border border-cyan-500/50 shadow-cyan-900/20'
                } ${(isLoading || (!dialogState.input.trim() && dialogState.type !== 'delete')) ? 'opacity-50 cursor-not-allowed' : ''}`}
                disabled={isLoading || (!dialogState.input.trim() && dialogState.type !== 'delete')}
              >
                {isLoading ? 'Processing...' : 
                 dialogState.type === 'delete' ? 'Delete Permanently' : 
                 dialogState.type === 'rename' ? 'Rename' : 
                 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
