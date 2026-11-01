import {clamp} from './driver.js';

export const DYNAMICS_TUNING=Object.freeze({
  earRest:[6,14], earDuration:0.62, earDelay:0.11,
  tailPeriod:5.6, swishDuration:2.8, swishCycles:2.5,
  swishRest:[45,85], tailPeak:28,
});
const smooth=x=>{x=clamp(x,0,1);return x*x*(3-2*x);};
const approach=(a,b,dt,tau)=>a+(b-a)*(1-Math.exp(-dt/tau));
// Fin flick: anticipation, brisk lift, two diminishing rebounds, then rest.
const EAR_KEYS=[[0,0],[0.10,1],[0.22,-0.34],[0.38,0.5],[0.55,-0.12],[1,0]];
function flick(t){
  if(t<=0||t>=1)return 0;
  for(let i=1;i<EAR_KEYS.length;i++){
    const [b,vb]=EAR_KEYS[i], [a,va]=EAR_KEYS[i-1];
    if(t<=b)return va+(vb-va)*smooth((t-a)/(b-a));
  }
  return 0;
}

// One owner for ambient and expressive ear/tail motion. No DOM or model writes.
export class SecondaryDynamics {
  constructor(random=Math.random){this.random=random;this.reset();}
  interval([a,b]){return a+clamp(this.random(),0,1)*(b-a);}
  reset(){
    this.time=0;this.ear=null;this.swish=null;
    this.nextEar=this.interval(DYNAMICS_TUNING.earRest);
    this.nextSwish=this.interval(DYNAMICS_TUNING.swishRest);
    this.earL=0;this.earR=0;this.mid=0;this.tip=0;
    this.started={ears:0,swishes:0};
    this.values={ParamEarL:0,ParamEarR:0,ParamTailSway:0,ParamTailTip:0};
  }
  triggerEar(side='auto'){
    if(!['auto','left','right','both'].includes(side))throw new Error(`Unknown ear side: ${side}`);
    if(this.ear)return false;
    const chosen=side==='auto'?(this.random()<0.5?'left':'right'):side;
    this.ear={at:this.time,side:chosen};this.started.ears++;
    this.nextEar=this.time+DYNAMICS_TUNING.earDuration+this.interval(DYNAMICS_TUNING.earRest);
    return true;
  }
  triggerSwish(){
    if(this.swish)return false;
    this.swish={at:this.time,direction:this.random()<0.5?-1:1};this.started.swishes++;
    this.nextSwish=this.time+DYNAMICS_TUNING.swishDuration+this.interval(DYNAMICS_TUNING.swishRest);
    return true;
  }
  cancelSwish(){
    this.swish=null;
    this.nextSwish=this.time+this.interval(DYNAMICS_TUNING.swishRest);
    // Outputs keep their current values; the next update damps them to ambient.
  }
  update(delta,{ears=true,tail=true,naturalEars=true,naturalTail=true,autoSwish=true,
    amplitude=0.8,activity=1,earPoseL=0,earPoseR=0,expressiveAllowed=true}={}){
    const dt=clamp(delta,0,0.05);this.time+=dt;
    if(!ears){this.ear=null;this.nextEar=this.time+this.interval(DYNAMICS_TUNING.earRest);}
    if(!tail){this.swish=null;this.nextSwish=this.time+this.interval(DYNAMICS_TUNING.swishRest);}
    if(this.ear&&this.time-this.ear.at>DYNAMICS_TUNING.earDuration+DYNAMICS_TUNING.earDelay)this.ear=null;
    if(this.swish&&this.time-this.swish.at>DYNAMICS_TUNING.swishDuration)this.swish=null;
    if(!expressiveAllowed&&this.swish)this.cancelSwish();
    if(this.time>=this.nextEar){
      if(ears&&naturalEars)this.triggerEar(this.random()<0.3?'both':'auto');
      else this.nextEar=this.time+this.interval(DYNAMICS_TUNING.earRest);
    }
    if(this.time>=this.nextSwish){
      if(tail&&autoSwish&&expressiveAllowed)this.triggerSwish();
      else this.nextSwish=this.time+this.interval(DYNAMICS_TUNING.swishRest);
    }
    let pulseL=0,pulseR=0;
    if(this.ear){
      const age=this.time-this.ear.at;
      const first=flick(age/DYNAMICS_TUNING.earDuration)*24;
      const second=flick((age-DYNAMICS_TUNING.earDelay)/DYNAMICS_TUNING.earDuration)*20;
      if(this.ear.side==='left')pulseL=first;
      else if(this.ear.side==='right')pulseR=first;
      else {pulseL=first;pulseR=second;}
    }
    const gain=clamp(amplitude,0,1.2),energy=clamp(activity,0,1);
    this.earL=approach(this.earL,ears?(earPoseL+pulseL*(0.4+0.6*energy))*gain:0,dt,0.035);
    this.earR=approach(this.earR,ears?(earPoseR+pulseR*(0.4+0.6*energy))*gain:0,dt,0.035);
    // A slowly modulated cycle avoids a constant-speed metronome silhouette.
    const phase=this.time*Math.PI*2/DYNAMICS_TUNING.tailPeriod+0.16*Math.sin(this.time*0.31);
    const ambient=naturalTail?(Math.sin(phase)*7.2+Math.sin(this.time*0.43)*1.6)*energy:0;
    let target=ambient,swishWeight=0;
    if(this.swish){
      const age=this.time-this.swish.at,t=age/DYNAMICS_TUNING.swishDuration;
      swishWeight=smooth(age/0.24)*smooth((DYNAMICS_TUNING.swishDuration-age)/0.55);
      const broad=Math.sin(t*Math.PI*2*DYNAMICS_TUNING.swishCycles)*DYNAMICS_TUNING.tailPeak*this.swish.direction;
      target=ambient*(1-swishWeight)+broad*swishWeight;
    }
    const tailTarget=tail?target*gain:0;
    this.mid=approach(this.mid,tailTarget,dt,swishWeight>0?0.075:0.22);
    this.tip=approach(this.tip,this.mid*1.06,dt,0.16);
    this.values={ParamEarL:clamp(this.earL,-30,30),ParamEarR:clamp(this.earR,-30,30),
      ParamTailSway:clamp(this.mid,-30,30),ParamTailTip:clamp(this.tip,-30,30)};
    return this.values;
  }
  getState(){return {time:this.time,ear:this.ear?.side??null,swishing:Boolean(this.swish),started:{...this.started}};}
}
