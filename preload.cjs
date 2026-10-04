const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('lineNative',{request:req=>ipcRenderer.invoke('line:request',req),pickFile:()=>ipcRenderer.invoke('line:pick-file'),onEvent:fn=>{const h=(_,msg)=>fn(msg);ipcRenderer.on('line:event',h);return()=>ipcRenderer.removeListener('line:event',h);}});
