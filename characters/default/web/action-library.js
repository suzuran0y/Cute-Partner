// Reusable Cubism files are loaded by the preview; no network model service here.
export const GESTURES=Object.freeze({
  'gesture.acknowledge':{label:'点头确认',file:'acknowledge',duration:1.1,channels:['head']},
  'gesture.decline':{label:'轻轻摇头',file:'decline',duration:1.4,channels:['head']},
  'gesture.curious':{label:'好奇歪头',file:'curious',duration:1.7,channels:['head']},
  'gesture.greet':{label:'招手',file:'greet',duration:2.4,channels:['head','left_arm'],blocked:['working','waiting','error','cancelled']},
  'interaction.tap':{label:'点击回应',file:'tap',duration:0.9,channels:['head','gaze']},
  'interaction.drag.pickup':{label:'提起',file:'drag-pickup',duration:0.35,channels:['head','body'],internal:true},
  'interaction.drag.land':{label:'落地收势',file:'drag-land',duration:0.85,channels:['head','body'],internal:true},
});
export const EXPRESSIONS=Object.freeze({neutral:'中立',friendly:'亲切',focused:'专注',curious:'好奇',concerned:'担忧',happy:'开心'});
export const ACTION_IDS=Object.freeze(['ParamHeadPitch','ParamHeadTurn','ParamArmLiftL','ParamHandWaveL','ParamHandOpenL','ParamEyeLSmile','ParamEyeRSmile']);

export async function loadActionLibrary(fetchJson){
  const motions=Object.fromEntries(await Promise.all(Object.entries(GESTURES).map(async([id,s])=>[id,await fetchJson(`/model/motions/${s.file}.motion3.json`)])));
  const expressions=Object.fromEntries(await Promise.all(Object.keys(EXPRESSIONS).map(async id=>[id,await fetchJson(`/model/expressions/${id}.exp3.json`)])));
  return {motions,expressions};
}
