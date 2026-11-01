import {PreviewMotionDriver, clamp} from './driver.js';
import {SecondaryDynamics} from './secondary-dynamics.js';

// State is supplied by the host. These presets never infer task completion.
export const STATES=Object.freeze({
  idle:{label:'待机',description:'自然动态与鼠标跟随',weight:0,tail:1},
  listening:{label:'注意／听取',description:'面向用户，双耳微抬，轻抬头',weight:0.9,y:4,by:1.2,browL:0.35,browR:0.35,earL:16,earR:16,tail:0.65},
  thinking:{label:'思考',description:'轻歪头，视线暂时偏移',weight:0.9,x:3,y:2,z:7,bx:0.7,ex:0.25,ey:0.2,browL:0.35,browR:-0.1,earL:8,earR:-3,tail:0.4},
  working:{label:'执行工作',description:'低头专注，身体略前倾，耳尾活动减弱',weight:0.9,y:-8,z:-1,by:-2,ey:-0.3,browL:-0.28,browR:-0.28,earL:-5,earR:-5,tail:0.2},
  waiting:{label:'等待',description:'收势并看向用户；等待原因由文字说明',weight:0.85,y:1,browL:0.12,browR:0.12,earL:4,earR:4,tail:0.35},
  speaking:{label:'输出回应',description:'面向用户，小幅点头；口型仅随实际音频幅度',weight:0.8,y:2,by:0.3,browL:0.2,browR:0.2,earL:7,earR:7,mouth:0.35,tail:0.6},
  success:{label:'完成',description:'短促点头、开心确认、尾巴轻摆，随后回待机',weight:1,y:2,browL:0.5,browR:0.5,earL:18,earR:18,mouth:0.8,tail:1,duration:1.8},
  error:{label:'异常／需处理',description:'停止工作姿态，轻歪头并看向用户',weight:1,y:-2,z:-6,browL:0.4,browR:-0.15,earL:-6,earR:-3,mouth:-0.4,tail:0.15},
  cancelled:{label:'已取消',description:'收到停止确认后收势，随后回待机',weight:0.9,y:-2,earL:-2,earR:-2,tail:0.3,duration:1.2}
});
export const EXTRA_IDS=Object.freeze(['ParamEarL','ParamEarR','ParamTailSway','ParamTailTip','ParamBrowLY','ParamBrowRY','ParamMouthForm','ParamMouthOpenY']);
const POSE_KEYS=['weight','x','y','z','bx','by','bz','ex','ey','browL','browR','earL','earR','mouth','tail'];
const smooth=t=>{const c=clamp(t,0,1);return c*c*(3-2*c);};
const poseOf=spec=>Object.fromEntries(POSE_KEYS.map(key=>[key,spec[key]??0]));

export class StateMotionDriver extends PreviewMotionDriver {
  constructor(random=Math.random) {
    super(random);
    this.stateId='idle';
    this.stateAge=0;
    this.transitionAge=0;
    this.pose=poseOf(STATES.idle);
    this.fromPose={...this.pose};
    this.pending=null;
    this.reason='';
    this.audioLevel=0;
    this.mouthLevel=0;
    this.stateWeight=1;this.faceWeight=1;
    this.options={ears:true,tail:true,face:true,stateMotion:true,naturalEars:true,naturalTail:true,autoSwish:true,dynamicAmplitude:0.8};
    this.dynamics=new SecondaryDynamics(random);
    this.earLeft=0;this.earRight=0;
    this.tailMid=0;this.tailTip=0;
    this.output=null;
    this.update(0);
  }
  setState(id,{reason='',confirmed=false,immediate=true}={}) {
    if(!STATES[id])throw new Error(`Unknown state: ${id}`);
    if((id==='success'||id==='cancelled')&&!confirmed)throw new Error('Terminal feedback requires a confirmed event');
    reason=String(reason).slice(0,160);
    if(id===this.stateId){this.reason=reason;this.pending=null;return false;}
    if(!immediate&&id!=='error'&&id!=='cancelled') {
      if(this.pending?.id===id){this.pending.reason=reason;return false;}
      this.pending={id,reason,confirmed,age:0};return true;
    }
    this.reason=reason;
    this.fromPose={...this.pose};
    this.stateId=id;this.stateAge=0;this.transitionAge=0;this.pending=null;
    if(this.dynamics){
      if(['working','waiting','error','cancelled'].includes(id))this.dynamics.cancelSwish();
      if(id==='success'&&this.options.tail&&this.options.stateMotion)this.dynamics.triggerSwish();
    }
    return true;
  }
  setAudioLevel(level) {this.audioLevel=clamp(level,0,1);}
  setSetting(name,value) {
    if(this.options&&['ears','tail','face','stateMotion','naturalEars','naturalTail','autoSwish'].includes(name))this.options[name]=Boolean(value);
    else if(this.options&&name==='dynamicAmplitude')this.options[name]=clamp(value,0,1.2);
    else super.setSetting(name,value);
  }
  resetSettings() {
    // Parent reset calls the virtual update: release a paused frame first.
    this.output=null;
    super.resetSettings();
    if(!this.options)return;
    Object.assign(this.options,{ears:true,tail:true,face:true,stateMotion:true,naturalEars:true,naturalTail:true,autoSwish:true,dynamicAmplitude:0.8});
    this.dynamics.reset();
    this.stateId='idle';this.stateAge=0;this.transitionAge=0;this.pending=null;this.reason='';
    this.pose=poseOf(STATES.idle);this.fromPose={...this.pose};
    this.audioLevel=0;this.mouthLevel=0;this.earLeft=0;this.earRight=0;this.tailMid=0;this.tailTip=0;
    this.stateWeight=1;this.faceWeight=1;
    this.output=null;
    this.update(0);
  }
  getValues() {return this.output??super.getValues();}
  expressiveAllowed(){return !['working','waiting','error','cancelled'].includes(this.stateId);}
  secondaryActivity(){return 1;}
  getState() {return {...super.getState(),stateId:this.stateId,stateAge:this.stateAge,reason:this.reason,pending:this.pending?.id??null,options:{...this.options},dynamics:this.dynamics?.getState()};}
  triggerReaction(id){
    if(this.paused)return false;
    if(id.startsWith('ear.'))return this.options.ears&&this.dynamics.triggerEar(id.slice(4));
    if(id==='tail.swish')return this.options.tail&&this.expressiveAllowed()&&this.dynamics.triggerSwish();
    throw new Error(`Unknown reaction: ${id}`);
  }
  update(delta) {
    if(this.options&&this.paused&&this.output)return this.output;
    const base={...super.update(delta)};
    if(!this.options)return base; // Parent constructor calls update before setup.
    const dt=clamp(delta,0,0.05);
    if(!this.paused) {
      this.stateAge+=dt;this.transitionAge+=dt;
      if(this.pending) {
        this.pending.age+=dt;
        if(this.pending.age>=0.22){const next=this.pending;this.setState(next.id,{reason:next.reason,confirmed:next.confirmed});}
      }
      const current=STATES[this.stateId];
      if(current.duration&&this.stateAge>=current.duration)this.setState('idle');
    }
    const spec=STATES[this.stateId];
    const target=poseOf(spec);
    const age=this.stateAge;
    if(this.stateId==='thinking') {
      target.x+=Math.sin(age*0.65)*1.5;target.ex+=Math.sin(age*0.55)*0.08;
    } else if(this.stateId==='working') {
      target.x+=Math.sin(age*0.8)*1.4;target.ex+=Math.sin(age*0.8)*0.15;
    } else if(this.stateId==='speaking') {
      target.y+=Math.sin(age*1.6)*1.2;target.z+=Math.sin(age*0.8)*1.3;
    } else if(this.stateId==='success') {
      const nod=Math.sin(clamp(age/1.5,0,1)*Math.PI*4)*Math.sin(clamp(age/1.8,0,1)*Math.PI);
      target.y-=nod*5;
    } else if(this.stateId==='cancelled') {
      target.y-=Math.sin(clamp(age/1.2,0,1)*Math.PI)*2;
    }
    const blend=smooth(this.transitionAge/0.5);
    this.pose=Object.fromEntries(POSE_KEYS.map(k=>[k,this.fromPose[k]+(target[k]-this.fromPose[k])*blend]));
    const p=this.pose;
    this.stateWeight+=((this.options.stateMotion?1:0)-this.stateWeight)*(1-Math.exp(-dt/0.2));
    this.faceWeight+=((this.options.face?1:0)-this.faceWeight)*(1-Math.exp(-dt/0.18));
    const active=this.stateWeight;
    const weight=p.weight*active;
    const mix=(id,value)=>base[id]+(value-base[id])*weight;
    for(const [id,key] of [['ParamAngleX','x'],['ParamAngleY','y'],['ParamAngleZ','z'],['ParamBodyAngleX','bx'],['ParamBodyAngleY','by'],['ParamBodyAngleZ','bz'],['ParamEyeBallX','ex'],['ParamEyeBallY','ey']])base[id]=mix(id,p[key]);
    const dynamics=this.dynamics.update(dt,{
      ...this.options,amplitude:this.options.dynamicAmplitude,activity:(1+(p.tail-1)*active)*this.secondaryActivity(),
      earPoseL:p.earL*active,earPoseR:p.earR*active,
      expressiveAllowed:this.expressiveAllowed(),
    });
    this.mouthLevel+=(this.audioLevel-this.mouthLevel)*(1-Math.exp(-dt/(this.audioLevel>this.mouthLevel?0.035:0.07)));
    Object.assign(base,{
      ...dynamics,
      ParamBrowLY:clamp(p.browL*active*this.faceWeight,-0.6,0.7),
      ParamBrowRY:clamp(p.browR*active*this.faceWeight,-0.6,0.7),
      ParamMouthForm:clamp(p.mouth*active*this.faceWeight,-1,1),
      ParamMouthOpenY:clamp(this.mouthLevel,0,1)
    });
    this.output=base;return base;
  }
}
