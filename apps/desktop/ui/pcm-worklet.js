class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const source = inputs[0]?.[0]; if (source?.length) this.port.postMessage(source.slice()); return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
