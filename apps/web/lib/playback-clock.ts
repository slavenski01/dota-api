/** Absolute monotonic clock: frame scheduling delays do not accumulate as drift. */
export class PlaybackClock {
  private wall = 0;
  private time = 0;
  private speed = 1;
  reset(wall:number,time:number,speed:number) { this.wall=wall;this.time=time;this.speed=speed; }
  at(wall:number,end:number) { return Math.min(end,this.time+Math.max(0,wall-this.wall)*this.speed/1000); }
}
