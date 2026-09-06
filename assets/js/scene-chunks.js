/* Full-resolution chunks: sequential fetch/decode bounds transient memory.
 * Exported separately so cancellation and partial-failure cleanup can be tested.
 */
export async function loadSceneChunks({manifestUrl,sceneId,signal,fetchImpl=fetch,decode,onProgress,onChunk,dispose}) {
 const response=await fetchImpl(manifestUrl,{signal});
 if(!response.ok)throw new Error(`Manifest request failed (${response.status})`);
 const manifest=await response.json();
 const scene=manifest.scenes.find(s=>s.id===sceneId);
 if(!scene?.chunks?.length)throw new Error('Scene is missing from the model manifest');
 let downloaded=0;
 for(let i=0;i<scene.chunks.length;i++){
  signal.throwIfAborted();
  const part=scene.chunks[i];
  onProgress({phase:'download',index:i+1,count:scene.chunks.length,loaded:downloaded,total:scene.bytes});
  const response=await fetchImpl(part.url,{signal});
  if(!response.ok)throw new Error(`Model request failed (${response.status})`);
  let bytes;
  if(response.body){
   const reader=response.body.getReader(),pieces=[];let length=0;
   try{while(true){const {done,value}=await reader.read();if(done)break;signal.throwIfAborted();pieces.push(value);length+=value.byteLength;onProgress({phase:'download',index:i+1,count:scene.chunks.length,loaded:downloaded+length,total:scene.bytes});}}finally{reader.releaseLock();}
   bytes=new Uint8Array(length);let offset=0;for(const piece of pieces){bytes.set(piece,offset);offset+=piece.byteLength;}
  }else bytes=new Uint8Array(await response.arrayBuffer());
  signal.throwIfAborted();
  if(bytes.byteLength!==part.bytes)throw new Error('Model download size does not match manifest');
  downloaded+=bytes.byteLength;
  onProgress({phase:'decode',index:i+1,count:scene.chunks.length,loaded:downloaded,total:scene.bytes});
  const model=await decode(bytes.buffer);
  if(signal.aborted){dispose(model);signal.throwIfAborted();}
  onChunk(model);
 }
 return scene;
}
