# AcousticForge Documentation

Welcome to AcousticForge, an open source audio calibration platform.

## Overview

AcousticForge is a platform that provides professional-grade audio calibration tools for everyone. Our goal is to make high-quality audio calibration accessible to all users, from home listeners to professional audio engineers.

## Architecture

The system is organized in a monorepo structure with the following packages:

- `@acoustic-forge/core` - Core DSP algorithms and signal processing functions
- `@acoustic-forge/ui` - User interface components
- `@acoustic-forge/shared` - Shared utilities and constants
- `lazyeq` - The main application package

## Core Components

### @acoustic-forge/core
Contains the Digital Signal Processing (DSP) algorithms that power our audio calibration.

### @acoustic-forge/ui
Provides user interface components and visualizations.

### @acoustic-forge/shared
Shared utilities and constants used across the platform.

### lazyEq
The flagship application that provides sine sweep EQ analysis for speaker calibration.

## Getting Started

To get started with development:

```bash
npm install
npm run dev
```

## Contributing

We welcome contributions from the audio engineering community. Please see our contributing guide for more information.

## License

This project is licensed under the MIT License - see the LICENSE file for details.