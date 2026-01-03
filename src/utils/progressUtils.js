/**
 * Progress Calculation Utilities
 * 
 * Stage-based progress calculation without time estimation.
 * Uses weighted progress ranges for each processing stage.
 */

const { PROGRESS_WEIGHTS } = require('./constants');

/**
 * Calculate progress for a given stage
 * @param {string} stage - Current processing stage
 * @param {number} stageProgress - Progress within the stage (0-1)
 * @returns {number} Overall progress (0-100)
 */
function calculateStageProgress(stage, stageProgress = 0) {
  const weights = PROGRESS_WEIGHTS[stage];
  if (!weights) {
    return 0;
  }
  
  const { start, end } = weights;
  const range = end - start;
  return Math.min(100, Math.floor(start + (stageProgress * range)));
}

/**
 * Calculate progress for chunk-based transcription
 * @param {number} chunkIndex - Current chunk index (1-based)
 * @param {number} totalChunks - Total number of chunks
 * @returns {number} Overall progress (0-100)
 */
function calculateChunkProgress(chunkIndex, totalChunks) {
  if (totalChunks <= 0) return PROGRESS_WEIGHTS.transcribing.start;
  
  const stageProgress = chunkIndex / totalChunks;
  return calculateStageProgress('transcribing', stageProgress);
}

/**
 * Get the start progress for a stage
 * @param {string} stage - Processing stage
 * @returns {number} Start progress for the stage
 */
function getStageStartProgress(stage) {
  return PROGRESS_WEIGHTS[stage]?.start || 0;
}

/**
 * Get the end progress for a stage
 * @param {string} stage - Processing stage
 * @returns {number} End progress for the stage
 */
function getStageEndProgress(stage) {
  return PROGRESS_WEIGHTS[stage]?.end || 100;
}

/**
 * Get all stages in order
 * @returns {string[]} Ordered array of stage names
 */
function getOrderedStages() {
  return Object.keys(PROGRESS_WEIGHTS);
}

/**
 * Get stage info including label for display
 * @param {string} stage - Stage key
 * @returns {Object} Stage info with label and icon
 */
function getStageInfo(stage) {
  const stageLabels = {
    uploading: { label: 'Mengunggah', icon: '📤' },
    queued: { label: 'Dalam Antrian', icon: '⏳' },
    downloading: { label: 'Mengunduh', icon: '📥' },
    transcribing: { label: 'Transkripsi', icon: '🎙️' },
    diarization: { label: 'Identifikasi Pembicara', icon: '👥' },
    ai_analysis: { label: 'Analisis AI', icon: '🤖' },
    saving: { label: 'Menyimpan', icon: '💾' },
    completed: { label: 'Selesai', icon: '✅' },
    error: { label: 'Error', icon: '❌' },
  };
  
  return stageLabels[stage] || { label: stage, icon: '⚙️' };
}

module.exports = {
  calculateStageProgress,
  calculateChunkProgress,
  getStageStartProgress,
  getStageEndProgress,
  getOrderedStages,
  getStageInfo,
};
