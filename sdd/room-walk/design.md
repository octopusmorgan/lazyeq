# Technical Design: Room Walk Mode

## Overview
This document outlines the technical design for implementing a Room Walk mode in lazyEq. This feature allows users to capture multiple measurements at different positions in a room and average them for a more accurate EQ profile.

## 1. RoomCalibration Class Design

### Constructor Parameters
```javascript
class RoomCalibration {
  constructor(audioContext, deviceId, noiseBuffer) {
    this.audioContext = audioContext;
    this.deviceId = deviceId;
    this.noiseBuffer = noiseBuffer; // Reuse existing noise floor calibration
    this.measurements = []; // Store individual measurements
    this.isCapturing = false;
    this.currentPosition = 0;
    this.totalPositions = 15;
    this.positionInterval = 2000; // 2 seconds between positions
    this.sweepDuration = 1; // 1 second per sweep
    this.onProgress = null; // Callback for UI updates
    this.onComplete = null; // Callback when all positions captured
  }
}
```

### Public Methods

#### start()
```javascript
async start() {
  this.isCapturing = true;
  this.currentPosition = 0;
  this.measurements = [];
  
  // Initialize analyzer with existing noise buffer
  this.analyzer = new SpectrumAnalyzer();
  await this.analyzer.init(this.deviceId, this.audioContext);
  this.analyzer.noiseBuffer = this.noiseBuffer;
  
  // Start capture sequence
  await this.captureSequence();
}
```

#### stop()
```javascript
stop() {
  this.isCapturing = false;
  if (this.currentSweep) {
    this.currentSweep.stop();
  }
  if (this.analyzer) {
    this.analyzer.destroy();
  }
}
```

#### getMeasurements()
```javascript
getMeasurements() {
  return this.measurements.map(m => ({ ...m })); // Return copies
}
```

#### getAveragedSpectrum()
```javascript
getAveragedSpectrum() {
  if (this.measurements.length === 0) return null;
  
  // Filter outliers first
  const filteredMeasurements = this.filterOutliers(this.measurements);
  
  // Calculate weighted average
  return this.calculateWeightedAverage(filteredMeasurements);
}
```

### Internal Methods

#### captureMeasurement()
```javascript
async captureMeasurement(position) {
  return new Promise(async (resolve, reject) => {
    try {
      // Create short sweep burst
      const sweepSource = new SineSweepSource(this.audioContext);
      sweepSource.createBuffer(this.sweepDuration);
      
      // Set up completion handler
      sweepSource.onComplete = async () => {
        // Get the accumulated spectrum during the sweep
        const spectrum = this.analyzer.getCurrentSpectrum();
        const rms = this.analyzer.getRMSLevel();
        
        resolve({
          position,
          spectrum: new Float32Array(spectrum),
          rms,
          timestamp: Date.now()
        });
      };
      
      // Start sweep and immediately begin analysis
      sweepSource.start();
      this.currentSweep = sweepSource;
    } catch (error) {
      reject(error);
    }
  });
}
```

#### filterOutliers()
```javascript
filterOutliers(measurements) {
  if (measurements.length <= 2) return measurements;
  
  // Calculate RMS values for all measurements
  const rmsValues = measurements.map(m => m.rms);
  
  // Calculate median and standard deviation
  const sorted = [...rmsValues].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  
  // Calculate median absolute deviation
  const deviations = rmsValues.map(rms => Math.abs(rms - median));
  const mad = sorted[Math.floor(deviations.length / 2)];
  const threshold = 2 * mad; // 2x median absolute deviation
  
  // Filter out measurements that deviate too much
  return measurements.filter(m => Math.abs(m.rms - median) <= threshold);
}
```

#### calculateWeightedAverage()
```javascript
calculateWeightedAverage(measurements) {
  if (measurements.length === 0) return null;
  if (measurements.length === 1) return measurements[0].spectrum;
  
  const spectrumLength = measurements[0].spectrum.length;
  const averagedSpectrum = new Float32Array(spectrumLength);
  
  // Convert to linear domain for averaging
  for (let i = 0; i < spectrumLength; i++) {
    let sum = 0;
    let weightSum = 0;
    
    for (const measurement of measurements) {
      // Weight by inverse variance (simpler approach: weight by position consistency)
      const weight = 1.0; // Could be enhanced with more sophisticated weighting
      const linearValue = Math.pow(10, measurement.spectrum[i] / 10);
      sum += linearValue * weight;
      weightSum += weight;
    }
    
    const averageLinear = sum / weightSum;
    averagedSpectrum[i] = 10 * Math.log10(averageLinear);
  }
  
  return averagedSpectrum;
}
```

#### captureSequence()
```javascript
async captureSequence() {
  for (let i = 0; i < this.totalPositions && this.isCapturing; i++) {
    this.currentPosition = i + 1;
    
    // Notify UI of progress
    if (this.onProgress) {
      this.onProgress({
        currentPosition: this.currentPosition,
        totalPositions: this.totalPositions,
        status: 'capturing'
      });
    }
    
    // Play audio cue (beep)
    this.playBeep();
    
    // Capture measurement
    try {
      const measurement = await this.captureMeasurement(this.currentPosition);
      this.measurements.push(measurement);
      
      // Notify UI of progress
      if (this.onProgress) {
        this.onProgress({
          currentPosition: this.currentPosition,
          totalPositions: this.totalPositions,
          status: 'completed',
          rms: measurement.rms
        });
      }
    } catch (error) {
      console.error(`Failed to capture position ${this.currentPosition}:`, error);
      // Continue with other positions
    }
    
    // Wait for next position (unless it's the last one)
    if (i < this.totalPositions - 1 && this.isCapturing) {
      await new Promise(resolve => setTimeout(resolve, this.positionInterval));
    }
  }
  
  // Complete capture sequence
  this.isCapturing = false;
  if (this.analyzer) {
    this.analyzer.destroy();
  }
  
  // Notify completion
  if (this.onComplete) {
    this.onComplete({
      measurements: this.measurements,
      averagedSpectrum: this.getAveragedSpectrum()
    });
  }
}
```

#### playBeep()
```javascript
playBeep() {
  try {
    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(this.audioContext.destination);
    
    oscillator.type = 'sine';
    oscillator.frequency.value = 880; // A5 note
    gainNode.gain.value = 0.3;
    
    oscillator.start();
    oscillator.stop(this.audioContext.currentTime + 0.1); // 100ms beep
  } catch (error) {
    console.warn('Could not play beep:', error);
  }
}
```

## 2. Integration with main.js

### Instantiation
```javascript
// In main.js, add after existing variable declarations
let roomCalibration = null;

// Add new DOM elements
const btnRoomWalk = document.getElementById("btn-room-walk");
const roomWalkOverlay = document.getElementById("room-walk-overlay");
const positionCounter = document.getElementById("position-counter");
const progressBar = document.getElementById("progress-bar");
```

### Event Handlers
```javascript
// Add Room Walk button event handler
btnRoomWalk.addEventListener("click", async () => {
  try {
    // Ensure noise floor is calibrated
    if (!analyzer || !analyzer.noiseBuffer) {
      statusNoise.textContent = "Please calibrate noise floor first!";
      statusNoise.className = "status danger";
      return;
    }
    
    // Initialize Room Calibration
    const ctx = await ensureAudioContext();
    roomCalibration = new RoomCalibration(ctx, selectedMicDeviceId, analyzer.noiseBuffer);
    
    // Set up callbacks
    roomCalibration.onProgress = (progress) => {
      updateRoomWalkUI(progress);
    };
    
    roomCalibration.onComplete = (result) => {
      processRoomWalkResults(result);
    };
    
    // Show overlay and start
    showRoomWalkOverlay();
    await roomCalibration.start();
  } catch (err) {
    console.error("Room walk error:", err);
    hideRoomWalkOverlay();
    statusSweep.textContent = "Error: " + err.message;
    statusSweep.className = "status danger";
  }
});

// Update UI during room walk
function updateRoomWalkUI(progress) {
  if (positionCounter) {
    positionCounter.textContent = `Position ${progress.currentPosition} of ${progress.totalPositions}`;
  }
  
  if (progressBar) {
    const percent = (progress.currentPosition / progress.totalPositions) * 100;
    progressBar.style.width = `${percent}%`;
  }
}

// Process results after room walk
async function processRoomWalkResults(result) {
  hideRoomWalkOverlay();
  
  if (!result.averagedSpectrum) {
    statusSweep.textContent = "No valid measurements captured";
    statusSweep.className = "status danger";
    return;
  }
  
  statusSweep.textContent = "Room walk analysis complete (Harman target)";
  statusSweep.className = "status done";
  
  // Process the averaged spectrum the same way as single-point
  const linearFreqLabels = analyzer.getLinearFrequencyLabels();
  const visData = generateVisualizationData(result.averagedSpectrum, linearFreqLabels);
  
  // Apply room-specific processing
  await processSpectrumForRoomEQ(visData);
}
```

### Flow Integration
The flow will be:
1. User calibrates noise floor (existing)
2. User selects "Room Walk" mode instead of "Play Sweep"
3. Room walk overlay appears with progress indicators
4. User walks around the room as 15 measurements are captured
5. Results are processed with room-specific EQ generation
6. Display results and enable export

## 3. UI Changes (index.html)

### New Room Walk Button
```html
<!-- Add after the existing sweep section -->
<section id="step-room-walk" class="card">
  <h2>2b. Room Walk Mode</h2>
  <p>Walk around your room while we capture 15 measurements for spatial averaging.</p>
  <button id="btn-room-walk" disabled>🚶 Start Room Walk</button>
  <p id="status-room-walk" class="status"></p>
</section>
```

### Progress Overlay HTML Structure
```html
<!-- Add before closing </body> tag -->
<div id="room-walk-overlay" class="overlay hidden">
  <div class="overlay-content">
    <h2>Room Walk in Progress</h2>
    <p>Walk around your listening area at a steady pace</p>
    <div class="progress-container">
      <div class="progress-bar-container">
        <div id="progress-bar" class="progress-bar"></div>
      </div>
      <div id="position-counter" class="position-counter">Position 0 of 15</div>
    </div>
    <p class="instruction">Beep indicates measurement capture</p>
    <button id="btn-cancel-room-walk" class="btn-stop">Cancel</button>
  </div>
</div>
```

### CSS Styling for Overlay
```css
/* Add to style.css */
.overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(10, 10, 15, 0.95);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.overlay.hidden {
  display: none;
}

.overlay-content {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 2rem;
  text-align: center;
  max-width: 90%;
  width: 500px;
}

.overlay-content h2 {
  margin-bottom: 1rem;
}

.progress-container {
  margin: 2rem 0;
}

.progress-bar-container {
  width: 100%;
  height: 8px;
  background: var(--bg);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 1rem;
}

.progress-bar {
  height: 100%;
  background: var(--accent);
  width: 0%;
  transition: width 0.3s ease;
}

.position-counter {
  font-size: 1.2rem;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 1rem;
}

.instruction {
  color: var(--text-muted);
  font-size: 0.875rem;
  margin-bottom: 1.5rem;
}

#btn-cancel-room-walk {
  margin-top: 1rem;
}
```

## 4. Data Flow

### Measurement Storage
- Each measurement is stored as an object with:
  - `position`: Position number (1-15)
  - `spectrum`: Float32Array of frequency response data
  - `rms`: Overall RMS level during capture
  - `timestamp`: Capture timestamp

### Memory Usage
- Each spectrum: ~8KB (2048 float values * 4 bytes)
- 15 measurements: ~120KB
- Averaged result: ~8KB
- Total additional memory: ~128KB (negligible for modern devices)

### Cleanup
- Measurements are cleared when:
  - Room walk is completed and results processed
  - User cancels the room walk
  - New room walk is started
- Audio resources are released after each capture

## 5. Modified EQ Generation

### Room Walk Mode Detection
```javascript
// In processSweepResults or new processRoomWalkResults function
function isRoomWalkMode() {
  return roomCalibration !== null && roomCalibration.measurements.length > 0;
}
```

### Different Limits for Room Walk
```javascript
// In the EQ generation section, modify limits based on mode
const MAX_GAIN = isRoomWalkMode() ? 6 : 12;  // More conservative for room walk
const MAX_CUT = isRoomWalkMode() ? -6 : -12;
const BASS_MAX = isRoomWalkMode() ? 3 : 4;
```

### Modified Processing for Room EQ
```javascript
async function processSpectrumForRoomEQ(visData) {
  // AutoEQ-inspired processing with room-specific adjustments
  const responseArr = new Float32Array(visData.length);
  visData.forEach((d, i) => { responseArr[i] = d.y; });
  
  // Use less aggressive smoothing for room walk to preserve some spatial characteristics
  const smoothingFactor = isRoomWalkMode() ? 1.5 : 2.0;
  const smoothedResponse = adaptiveSmooth(responseArr, smoothingFactor);
  
  // Normalize: average between 100Hz-10kHz should be 0dB
  let sumRange = 0, countRange = 0;
  for (let i = 0; i < smoothedResponse.length; i++) {
    const freq = visData[i].x;
    if (freq >= 100 && freq <= 10000 && smoothedResponse[i] > -90 && isFinite(smoothedResponse[i])) {
      sumRange += smoothedResponse[i];
      countRange++;
    }
  }
  const rangeAvg = countRange > 0 ? sumRange / countRange : 0;
  
  const normalizedResponse = new Float32Array(smoothedResponse.length);
  for (let i = 0; i < smoothedResponse.length; i++) {
    normalizedResponse[i] = smoothedResponse[i] - rangeAvg;
  }
  
  // Room-specific target curve (slightly warmer)
  function getRoomTarget(freq) {
    if (freq < 80) return -3;  // Less bass boost for room modes
    if (freq < 200) return 1;  // Slight boost in upper bass
    if (freq < 2000) return 0;
    if (freq < 6000) return 1;
    return 2;
  }
  
  // Calculate gains with room-specific limits
  const MAX_GAIN = isRoomWalkMode() ? 6 : 12;
  const MAX_CUT = isRoomWalkMode() ? -6 : -12;
  const BASS_MAX = isRoomWalkMode() ? 3 : 4;
  
  const rawGains = new Float32Array(visData.length);
  for (let i = 0; i < visData.length; i++) {
    const targetOffset = getRoomTarget(visData[i].x);
    rawGains[i] = targetOffset - normalizedResponse[i];
  }
  
  const gains = Array.from(rawGains).map((g, i) => {
    let gain = g;
    if (visData[i].x < 100) {
      gain = Math.min(gain, BASS_MAX);
    }
    gain = Math.max(MAX_CUT, Math.min(MAX_GAIN, gain));
    return gain;
  });
  
  // Render graphs (same as existing)
  renderResults(normalizedResponse, gains, visData);
  
  // Enable export buttons
  btnExportWavelet.disabled = false;
  btnExportEqMac.disabled = false;
  btnExportWavelet.dataset.gains = JSON.stringify(gains);
  btnExportEqMac.dataset.gains = JSON.stringify(gains);
}
```

## 6. Additional Considerations

### Error Handling
- Handle cases where microphone access is lost during room walk
- Handle browser tab switching (audio context suspension)
- Handle insufficient measurements (less than 3 valid captures)

### Performance Optimization
- Reuse AudioContext and analyzer where possible
- Limit DOM updates during capture sequence
- Use requestAnimationFrame for smooth progress updates

### User Experience Enhancements
- Add visual spectrum display during room walk (delayed from previous position)
- Add "bad capture" indicator if RMS levels are inconsistent
- Provide before/after comparison of room walk vs single-point results

## 7. Implementation Steps

1. Create RoomCalibration class in new file `src/roomCalibration.js`
2. Add UI elements to index.html
3. Add CSS styling for overlay
4. Modify main.js to integrate room walk functionality
5. Update EQ generation to handle room walk mode
6. Add audio cues and progress indicators
7. Implement outlier filtering and weighted averaging
8. Test with various room environments