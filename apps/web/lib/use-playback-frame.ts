"use client";
import { useEffect, useMemo, useState } from "react";
import type { MatchFrame, PlaybackWindow } from "@dota/jobs";
import { api } from "./source-errors";
import { observedFrame, PlaybackCache, playbackScope, PLAYBACK_VERSION, WINDOW_SECONDS } from "./playback-cache";

export function usePlaybackFrame<T extends MatchFrame>({ datasetId, accountId, matchId, mode, time, retry, enabled = true, episodeId }:
  {datasetId:string;accountId:string;matchId:string;mode:string;time:number;retry:number;enabled?:boolean;episodeId?:string}) {
  const scope = JSON.stringify([matchId,playbackScope(datasetId,accountId,mode,episodeId)]);
  const cache = useMemo(()=>{ const value=new PlaybackCache(); value.reset(scope); return value; },[scope]);
  const [, changed] = useState(0);
  const [failure,setFailure] = useState<{key:string;message:string}|null>(null);
  const [last,setLast] = useState<{scope:string;frame:T}|null>(null);
  const bucket = Math.floor(time/WINDOW_SECONDS), key=`${scope}:${bucket}:${retry}`;
  const valid=enabled && !!datasetId && !!accountId && Number.isFinite(time) && ["decision","retrospective"].includes(mode);
  const window = valid ? cache.get(bucket) : undefined;
  cache.pin(bucket);
  useEffect(()=>{
    if (!valid) return;
    const controller=new AbortController(), generation=cache.generation;
    async function read(index:number) {
      const existing=cache.get(index);if(existing)return existing;
      const query=new URLSearchParams({accountId,mode,resource:"playback",version:PLAYBACK_VERSION,bucket:String(index),...(episodeId?{episodeId}:{})});
      const value=await api<PlaybackWindow>(`/api/datasets/${encodeURIComponent(datasetId)}/explore?${query}`,{signal:controller.signal});
      if(controller.signal.aborted)return;
      if(value.bucket!==index || value.frame.matchId!==matchId || value.frame.datasetId!==datasetId || value.frame.accountId!==accountId || value.frame.mode!==mode || (episodeId && (!("episodeId" in value.frame) || value.frame.episodeId!==episodeId))) throw new Error("Интервал относится к другому контексту.");
      if(cache.put(scope,generation,value,new TextEncoder().encode(JSON.stringify(value)).byteLength))changed(n=>n+1);
      return value;
    }
    setFailure(null);
    void read(bucket).then(async current=>{
      if(!current || controller.signal.aborted)return;
      const bounds=current.frame.window;
      await Promise.allSettled([bucket+1,bucket-1].filter(i=>i*WINDOW_SECONDS<=bounds.endSeconds&&(i+1)*WINDOW_SECONDS>bounds.startSeconds).map(read));
    }).catch(error=>{if(!controller.signal.aborted)setFailure({key,message:error.message});});
    return ()=>controller.abort();
  },[cache,scope,bucket,valid,retry,key,accountId,datasetId,mode,matchId,episodeId]);
  const current = useMemo(()=>window ? observedFrame(window,time) as T : null,[window,time]);
  useEffect(()=>{if(current)setLast({scope,frame:current});},[current,scope]);
  const error=failure?.key===key ? failure.message : null;
  return {frame:valid ? current ?? (last?.scope===scope ? last.frame : null) : null,error,pending:valid&&!current&&!error,ready:!!current,window,cache};
}
