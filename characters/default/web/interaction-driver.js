import {StateMotionDriver} from './state-driver.js';
import {clamp} from './driver.js';
import {GESTURES,EXPRESSIONS} from './action-library.js';

const ease=t=>{t=clamp(t,0,1);return t*t*(3-2*t);};
const cubic=(a,b,c,d,t)=>{const u=1-t;return u*u*u*a+3*u*u*t*b+3*u*t*t*c+t*t*t*d;};
const union=(a,b)=>new Set([...Object.keys(a),...Object.keys(b)]);
const blend=(a,b,t)=>Object.fromEntries([...union(a,b)].map(id=>[id,(a[id]??0)+((b[id]??0)-(a[id]??0))*t]));
const FACE_DEFAULTS={ParamEyeLOpen:1,ParamEyeROpen:1,ParamEyeLSmile:0,ParamEyeRSmile:0,ParamBrowLY:0,ParamBrowRY:0,ParamMouthForm:0};

// Supports Cubism linear, restricted/unrestricted Bezier, stepped and inverse stepped segments.
export function sampleCurve(curve,time){
  const s=curve.Segments;let t0=s[0],v0=s[1];
  if(time<=t0)return v0;
  for(let i=2;i<s.length;){
    const kind=s[i++];
    if(kind===1){
      const [a,b,c,d,t1,v1]=s.slice(i,i+6);i+=6;
      if(time<=t1){let lo=0,hi=1;for(let n=0;n<28;n++){const m=(lo+hi)/2;if(cubic(t0,a,c,t1,m)<time)lo=m;else hi=m;}return cubic(v0,b,d,v1,(lo+hi)/2);}
      t0=t1;v0=v1;
    }else{
      const t1=s[i++],v1=s[i++];
      if(time<=t1){if(kind===2)return time<t1?v0:v1;if(kind===3)return v1;return v0+(v1-v0)*(time-t0)/(t1-t0);}
      t0=t1;v0=v1;
    }
  }
  return v0;
}
export function validateMotion(motion){
  if(motion.Version!==3||!Number.isFinite(motion.Meta?.Duration)||motion.Meta.Duration<=0||!Array.isArray(motion.Curves))throw new Error('Invalid motion3');
  const seen=new Set();
  for(const c of motion.Curves){
    const s=c.Segments;
    if(c.Target!=='Parameter'||seen.has(c.Id)||!Array.isArray(s)||s.length<2||!s.every(Number.isFinite))throw new Error('Invalid motion curve');
    seen.add(c.Id);let t=s[0];
    for(let i=2;i<s.length;){const kind=s[i++];if(![0,1,2,3].includes(kind))throw new Error('Unknown segment');const size=kind===1?6:2;if(i+size>s.length)throw new Error('Truncated segment');const end=s[i+size-2];if(end<=t||end>motion.Meta.Duration+1e-6)throw new Error('Invalid segment time');if(kind===1&&(s[i]<t||s[i+2]<s[i]||s[i+2]>end))throw new Error('Non-monotonic Bezier time');t=end;i+=size;}
  }
  return motion;
}

export class InteractionMotionDriver extends StateMotionDriver{
  constructor(random=Math.random){
    super(random);
    this.library=null;this.clip=null;this.offset={};this.release=null;this.dragging=false;this.dragTilt=0;this.dragInputAge=0;
    this.expressionId='auto';this.expressionAge=1;this.expressionValues={...FACE_DEFAULTS};this.expressionFrom={...FACE_DEFAULTS};this.expressionWeight=0;this.expressionFromWeight=0;this.expressionTargetWeight=0;
    this.update(0);
  }
  installLibrary(library){
    for(const id of Object.keys(GESTURES))validateMotion(library.motions[id]);
    for(const id of Object.keys(EXPRESSIONS)){
      const e=library.expressions[id];
      if(e?.Type!=='Live2D Expression'||!Array.isArray(e.Parameters)||e.Parameters.some(p=>!Object.hasOwn(FACE_DEFAULTS,p.Id)||!Number.isFinite(p.Value)||p.Blend!=='Overwrite'))throw new Error(`Invalid expression ${id}`);
    }
    this.library=library;
  }
  setExpression(id){
    if(this.paused||!this.library)return false;
    if(id!=='auto'&&!EXPRESSIONS[id])throw new Error(`Unknown expression ${id}`);
    if(id===this.expressionId)return false;
    this.expressionFrom={...this.expressionValues};this.expressionFromWeight=this.expressionWeight;
    this.expressionId=id;this.expressionAge=0;this.expressionTargetWeight=id==='auto'?0:1;
    this.expressionTarget=id==='auto'?{...this.expressionValues}:{...FACE_DEFAULTS,...Object.fromEntries(this.library.expressions[id].Parameters.map(p=>[p.Id,p.Value]))};
    if(id==='happy')this.triggerReaction('tail.swish');
    return true;
  }
  setState(id,options){
    const changed=super.setState(id,options);
    if(changed&&this.offset&&['working','waiting','error','cancelled'].includes(id)){this.dragging=false;this.cancelGesture();}
    return changed;
  }
  expressiveAllowed(){return super.expressiveAllowed()&&!this.dragging&&!this.clip?.id.startsWith('interaction.drag')&&!this.dragSettling;}
  secondaryActivity(){return this.dragging||this.clip?.id.startsWith('interaction.drag')||this.dragSettling?0.25:1;}
  triggerGesture(id,{direction=1}={}){
    if(!GESTURES[id]||GESTURES[id].internal)throw new Error(`Unknown gesture ${id}`);
    if(this.paused||!this.library||this.dragging||this.dragSettling||GESTURES[id].blocked?.includes(this.stateId))return false;
    if(this.clip?.id===id)return false; // Coalesce repeated clicks; never accumulate a queue.
    this.#start(id,direction);return true;
  }
  #start(id,direction=1){this.clip={id,age:0,from:{...this.offset},direction:clamp(direction,-1,1)};this.release=null;}
  cancelGesture(){
    this.clip=null;this.release={age:0,from:{...this.offset}};
  }
  beginDrag(){
    if(this.paused||!this.library||this.dragging)return false;
    this.dragging=true;this.dragTilt=0;this.dragInputAge=0;this.dragSettling=false;this.dynamics.cancelSwish();this.#start('interaction.drag.pickup');return true;
  }
  moveDrag(horizontalSpeed){if(this.dragging){this.dragTilt=clamp(horizontalSpeed,-1,1);this.dragInputAge=0;}}
  endDrag(){
    if(!this.dragging)return false;
    this.dragging=false;this.dragTilt=0;this.dragSettling=true;this.#start('interaction.drag.land');return true;
  }
  resetSettings(){
    // Clear the composition before the parent's virtual update/reset calls.
    this.clip=null;this.offset={};this.release=null;this.dragging=false;this.dragTilt=0;this.dragInputAge=0;this.dragSettling=false;
    this.expressionId='auto';this.expressionAge=1;this.expressionValues={...FACE_DEFAULTS};this.expressionFrom={...FACE_DEFAULTS};this.expressionWeight=0;this.expressionFromWeight=0;this.expressionTargetWeight=0;this.expressionTarget={...FACE_DEFAULTS};
    super.resetSettings();this.update(0);
  }
  getState(){return {...super.getState(),gesture:this.clip?.id??null,gestureAge:this.clip?.age??0,settling:Boolean(this.release),dragging:this.dragging,expression:this.expressionId,actionLibraryReady:Boolean(this.library)};}
  update(delta){
    if(this.library&&this.paused&&this.output)return this.output;
    const base={...super.update(delta)};
    if(!this.offset)return base;
    const dt=this.paused?0:clamp(delta,0,0.05);
    this.dragInputAge+=dt;if(this.dragInputAge>0.1)this.dragTilt*=Math.exp(-dt/0.18);
    Object.assign(base,{ParamHeadTurn:clamp(base.ParamAngleX/20*0.4,-0.5,0.5),ParamHeadPitch:clamp(-base.ParamAngleY/15*0.35,-0.45,0.45),ParamArmLiftL:0,ParamHandWaveL:0,ParamHandOpenL:0,ParamEyeLSmile:0,ParamEyeRSmile:0});
    if(this.clip){
      const clip=this.clip,motion=this.library.motions[clip.id];clip.age+=dt;
      const target=Object.fromEntries(motion.Curves.map(c=>[c.Id,sampleCurve(c,clip.age)]));
      if(clip.id==='interaction.tap'){target.ParamHeadTurn*=clip.direction;target.ParamEyeBallX*=clip.direction;}
      if(this.dragging&&clip.age>=motion.Meta.Duration)target.ParamAngleZ=(target.ParamAngleZ??0)+this.dragTilt*5;
      this.offset=blend(clip.from,target,ease(clip.age/0.12));
      if(clip.age>=motion.Meta.Duration&&!this.dragging)this.cancelGesture();
    }else if(this.release){
      this.release.age+=dt;this.offset=blend(this.release.from,{},ease(this.release.age/0.22));
      if(this.release.age>=0.22){this.release=null;this.offset={};this.dragSettling=false;}
    }
    for(const [id,value] of Object.entries(this.offset))base[id]=(base[id]??0)+value;
    this.expressionAge+=dt;
    const e=ease(this.expressionAge/0.25);
    this.expressionWeight=this.expressionFromWeight+(this.expressionTargetWeight-this.expressionFromWeight)*e;
    this.expressionValues=blend(this.expressionFrom,this.expressionTarget??FACE_DEFAULTS,e);
    const weight=this.expressionWeight*this.faceWeight;
    for(const [id,value] of Object.entries(this.expressionValues)){
      if(id==='ParamEyeLOpen'||id==='ParamEyeROpen')base[id]*=1+(value-1)*weight;
      else base[id]=(base[id]??0)+(value-(base[id]??0))*weight;
    }
    for(const id of ['ParamHeadPitch','ParamHeadTurn','ParamMouthForm'])base[id]=clamp(base[id],-1,1);
    base.ParamArmLiftL=clamp(base.ParamArmLiftL,0,30);base.ParamHandWaveL=clamp(base.ParamHandWaveL,-30,30);base.ParamHandOpenL=clamp(base.ParamHandOpenL,0,1);
    for(const id of ['ParamEyeBallX','ParamEyeBallY'])base[id]=clamp(base[id],-1,1);
    this.output=base;return base;
  }
}
