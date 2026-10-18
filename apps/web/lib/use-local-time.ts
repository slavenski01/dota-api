"use client";
import { useEffect, useRef, useState } from "react";

/** Local animation time is independent of URL persistence and browser navigation. */
export function useLocalTime(external:number,scope:string) {
  const [local,setLocal]=useState({scope,external,value:external});
  const time=local.scope===scope && Object.is(local.external,external) ? local.value : external;
  const pending=useRef<{scope:string;value:number}|null>(null), animation=useRef<number|null>(null);
  useEffect(()=>{setLocal({scope,external,value:external});return ()=>{if(animation.current!==null)cancelAnimationFrame(animation.current);animation.current=null;pending.current=null;};},[scope,external]);
  function set(value:number) { pending.current=null;if(animation.current!==null)cancelAnimationFrame(animation.current);animation.current=null;setLocal({scope,external,value}); }
  function scrub(value:number) {
    pending.current={scope,value};
    if(animation.current===null)animation.current=requestAnimationFrame(()=>{animation.current=null;if(pending.current?.scope===scope)setLocal({scope,external,value:pending.current.value});});
  }
  function finish() {const value=pending.current?.scope===scope ? pending.current.value : time;set(value);return value;}
  return {time,set,scrub,finish};
}
