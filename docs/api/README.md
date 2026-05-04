# API Documentation

## Core API

The Core API provides access to the underlying Digital Signal Processing algorithms that power AcousticForge.

### Installation

```bash
npm install @acoustic-forge/core
```

### Usage

```javascript
import { Analyzer } from '@acoustic-forge/core/analyzer'
import { SineSweep } from '@acoustic-forge/core/sineSweep'
```

## Modules

### DSP Module
Contains the core signal processing algorithms for audio analysis.

### Calibration Module
Handles room acoustics measurement and calibration.

### Export Module
Handles exporting calibration profiles to various audio applications.

## Functions

### Analyzer
The main analyzer component that handles audio input processing and frequency analysis.

### SineSweep
Generates logarithmic sine sweep signals for frequency response measurement.

### RoomCalibration
Processes spatial averaging for consistent room correction across multiple measurement positions.

### EQGenerator
Generates EQ profiles based on Harman target curves and measured responses.