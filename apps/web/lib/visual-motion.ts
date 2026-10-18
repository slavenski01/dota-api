import type { MotionSample } from "@dota/contracts";
import type { PlaybackWindow } from "@dota/jobs";

export interface VisualPosition { playerSlot:number; mapPosition:{x:number;y:number}|null; observedTime:number; alive:boolean|null; interpolated:boolean }
const indices = new WeakMap<PlaybackWindow,Map<number,MotionSample[]>>();
function index(window:PlaybackWindow) {
  let result=indices.get(window);if(result)return result;
  result=new Map();
  for(const track of window.motion) {
    if(track.provenance.sourceVersion!=="normalized-v2/clarity-5.0.1/protobuf-7.1")continue;
    const rows=result.get(track.playerSlot)??[];rows.push(...track.samples);result.set(track.playerSlot,rows);
  }
  for(const rows of result.values())rows.sort((a,b)=>a.time-b.time);
  indices.set(window,result);return result;
}
export function canSmooth(a:MotionSample,b:MotionSample) {
  const dt=b.time-a.time;
  return b.breakBefore===null && a.alive===true && b.alive===true && a.x!==null && a.y!==null && b.x!==null && b.y!==null &&
    dt>0 && dt<=0.3 && Math.hypot(b.x-a.x,b.y-a.y)<=Math.min(180,750*dt);
}
/** Display only. Does not write to observations or the analytical frame. No extrapolation. */
export function visualPositions(window:PlaybackWindow|undefined,time:number):VisualPosition[]|undefined {
  if(!window || !window.motionAvailable)return undefined;
  if(window.frame.mode!=="retrospective")return [];
  const result:VisualPosition[]=[];
  for(const [slot,rows] of index(window)) {
    let lo=0,hi=rows.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(rows[mid]!.time<=time)lo=mid+1;else hi=mid;}
    const a=rows[lo-1],b=rows[lo];
    if(!a || time-a.time>0.3 || a.x===null || a.y===null || rows[lo-2]?.time===a.time)continue;
    let x=a.x,y=a.y,interpolated=false;
    if(b && time>a.time && canSmooth(a,b)) {const f=(time-a.time)/(b.time-a.time);x+=(b.x!-x)*f;y+=(b.y!-y)*f;interpolated=true;}
    const point={x:(x+8192)/16256*100,y:(8064-y)/16256*100};
    result.push({playerSlot:slot,mapPosition:point.x>=0&&point.x<=100&&point.y>=0&&point.y<=100?point:null,observedTime:a.time,alive:a.alive,interpolated});
  }
  return result;
}
