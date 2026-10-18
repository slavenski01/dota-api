"use client";
import { useEffect, useRef, useState } from "react";
import { PlaybackClock } from "./playback-clock";

export function usePlayback(options:{key:string;time:number;end:number;enabled:boolean;ready:boolean;setTime:(time:number)=>void;commit:(time:number)=>void}) {
  const [run,setRun]=useState<string|null>(null),[speed,setSpeed]=useState(1);
  const playing=run===options.key;
  const latest=useRef(options);latest.current=options;
  const stats=useRef({frames:0,elapsedMs:0,maxFrameMs:0,bufferMs:0});
  useEffect(()=>{setRun(null);},[options.key]);
  useEffect(()=>{
    if(!playing)return;
    const clock=new PlaybackClock();let first=true,lastWall:number|null=null,animation=0;
    const tick=(wall:number)=>{
      const o=latest.current;
      if(!o.enabled || document.hidden){setRun(null);if(Number.isFinite(o.time))o.commit(o.time);return;}
      if(lastWall!==null){const dt=wall-lastWall;stats.current.elapsedMs+=dt;stats.current.maxFrameMs=Math.max(stats.current.maxFrameMs,dt);if(!o.ready)stats.current.bufferMs+=dt;}
      lastWall=wall;stats.current.frames++;
      if(first || !o.ready){clock.reset(wall,o.time,speed);first=!o.ready;}
      else {
        const time=clock.at(wall,o.end);o.setTime(time);
        if(time>=o.end){setRun(null);o.commit(o.end);return;}
      }
      animation=requestAnimationFrame(tick);
    };
    animation=requestAnimationFrame(tick);
    return ()=>cancelAnimationFrame(animation);
  },[playing,options.key,speed]);
  useEffect(()=>{
    const hidden=()=>{if(document.hidden && playing){setRun(null);const o=latest.current;o.commit(o.time);}};
    document.addEventListener("visibilitychange",hidden);
    return ()=>document.removeEventListener("visibilitychange",hidden);
  },[playing]);
  function stop(commit=false){setRun(null);if(commit && Number.isFinite(latest.current.time))latest.current.commit(latest.current.time);}
  function toggle(){if(playing)stop(true);else if(options.enabled && options.time<options.end && !document.hidden){stats.current={frames:0,elapsedMs:0,maxFrameMs:0,bufferMs:0};setRun(options.key);}}
  return {playing,speed,setSpeed,stop,toggle,stats:stats.current};
}
