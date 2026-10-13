/** Tunable voice-to-mouth response, independent of playback and avatar rigs. */
export class AmplitudeEnvelope {
  private samples = new Float32Array(1024);
  private opening = 0;

  sample(analyser: AnalyserNode, dt: number) {
    analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const sample of this.samples) sum += sample * sample;
    const rms = Math.sqrt(sum / this.samples.length);
    const amplitudeRange = 0.09;
    const responseCurve = 0.55;
    const target = Math.pow(
      Math.max(0, Math.min(1, (rms - 0.008) / amplitudeRange)),
      responseCurve,
    );
    const smoothing = 1 - Math.exp(-dt / (target > this.opening ? 0.035 : 0.07));
    this.opening += (target - this.opening) * smoothing;
    return this.opening;
  }

  reset() {
    this.opening = 0;
  }
}
