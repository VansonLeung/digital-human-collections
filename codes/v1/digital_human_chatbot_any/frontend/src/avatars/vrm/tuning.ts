/** Avatar tuning stays separate from the gesture definitions and playback clock. */
export const vrmTuning = {
  bodyGestureStrength: 1,
  mouthOpeningRatio: 1,
  facialExpressionStrength: 1,
  // Mira's eye geometry clips at large angles. Keep the sideways glance visible
  // without forcing full eye contact from a three-quarter head turn.
  poseGazeMaxDegrees: 12,
  // Expression-based eyes (Seed-san) reach their authored full glance here.
  poseGazeExpressionInputDegrees: 30,
};
