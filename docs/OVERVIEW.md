# AcousticForge Project Overview

**Precision Audio Calibration for Everyone**

AcousticForge is an open-source audio calibration platform dedicated to democratizing professional-grade audio tools. We build free, transparent, community-driven software that helps users achieve studio-quality sound in any environment—from home listening setups to professional studios.

---

## Vision

We envision a world where high-quality audio calibration is not a luxury reserved for expensive commercial solutions, but a universally accessible right for every audio enthusiast, musician, podcaster, and content creator.

The audio industry has long been dominated by proprietary, closed-source solutions that hide their methodologies behind paywalls and black-box algorithms. AcousticForge exists to break this pattern. We believe that when algorithms are transparent, communities can verify them, improve them, and adapt them to novel use cases that the original developers never anticipated.

Our vision extends beyond a single tool. We are building an ecosystem of open audio technologies—calibration, measurement, correction, and enhancement—that work together seamlessly and remain freely available forever. We envision a future where acoustic treatment and equalization are as commonplace and understood as WiFi troubleshooting is today.

---

## Mission

Our mission is to create and maintain open-source audio calibration tools that are:

- **Accessible**: Free for everyone, forever. No paywalls, no locked features, no tiered subscriptions.
- **Transparent**: Every algorithm, every calculation, every methodology is open for inspection, scrutiny, and improvement.
- **Community-Driven**: We build with the community, for the community. Audio engineers, developers, and enthusiasts shape our roadmap.
- **Professional Grade**: Our tools meet the standards of professional audio work, not consumer gimmicks.
- **Cross-Platform**: Accessible to anyone regardless of operating system, hardware, or technical background.

We achieve this mission by maintaining rigorous code quality, comprehensive documentation, and an inclusive contribution process that welcomes expertise from all domains—DSP engineering, UI/UX design, acoustics research, and user experience.

---

## Architecture

AcousticForge is organized as a **monorepo** using npm workspaces, enabling independent development and testing of packages while maintaining a unified release pipeline.

### Repository Structure

```
acoustic-forge/
├── packages/
│   ├── lazyeq/                  # Flagship calibration application
│   └── @acoustic-forge/
│       ├── core/               # DSP algorithms and signal processing
│       ├── ui/                 # Reusable UI components and visualizations
│       └── shared/             # Constants, types, and utilities
├── docs/                       # Project documentation
├── tests/                      # Integration and end-to-end tests
└── vite.config.js             # Build configuration
```

### Core Packages

#### @acoustic-forge/core

The foundation of all AcousticForge products. This package contains the Digital Signal Processing (DSP) algorithms that power our audio calibration engine:

- **Sine Sweep Generation**: Industry-standard logarithmic sine sweeps for frequency response measurement
- **Impulse Response Extraction**: Time-domain analysis for calculating room acoustics
- **Frequency Response Calculation**: FFT-based transformation of impulse responses
- **EQ Profile Generation**: Translation of measured response curves into corrective equalization curves
- **Smoothing Algorithms**: Statistical smoothing (e.g., 1/3 octave smoothing) for visual presentation

The core package has zero UI dependencies, making it suitable for embedding in other applications, command-line tools, or server-side processing.

#### @acoustic-forge/ui

Provides visualization components and user interface primitives built on top of the core:

- **Real-Time Visualizers**: Canvas-based frequency response graphs, spectrum analyzers, and time-domain displays
- **Interactive Controls**: Parameter sliders, frequency band editors, and preview panels
- **Responsive Layouts**: Mobile-friendly interfaces that work across desktop and tablet devices

The UI package is framework-agnostic where possible, using vanilla JavaScript and CSS modules for maximum compatibility.

#### @acoustic-forge/shared

Shared constants, type definitions, and utility functions used across all packages:

- **TypeScript Interfaces**: Type-safe contracts for audio data structures, measurement results, and configuration objects
- **Frequency Band Definitions**: Standard ISO and custom frequency band configurations
- **Default Configuration**: Sensible defaults for measurement parameters, smoothing options, and output formats

#### lazyeq

The flagship desktop application that brings together the core packages into a user-facing calibration tool:

- **Sine Sweep Playback**: High-quality audio generation through Web Audio API
- **Microphone Input Capture**: Real-time audio recording from system or external microphones
- **Measurement Workflow**: Guided multi-point measurements for comprehensive room analysis
- **Profile Export**: Export generated EQ profiles in multiple formats (parametric EQ, graphic EQ, convolution)

lazyeq serves as the reference implementation of our core packages and demonstrates best practices for integrating the DSP engine into a production application.

### Technology Stack

| Layer | Technology | Rationale |
|-------|------------|------------|
| Signal Processing | Web Audio API | Browser-native, hardware-accelerated, zero-latency audio I/O |
| Visualization | Canvas API | High-performance 2D graphics for real-time rendering |
| Package Management | npm workspaces | Native monorepo support with hoisted dependencies |
| Build Tool | Vite | Fast development server, optimized production builds |
| Language | JavaScript / ES6 Modules | Maximum portability across environments |

The browser-based architecture eliminates the need for platform-specific installers and enables instant deployment. Users calibrate their systems directly in the browser without installing native software.

---

## Products

### lazyeq

**The flagship room calibration equalizer**

lazyeq is a browser-based room correction tool that uses sine sweep analysis to automatically generate corrective EQ profiles for loudspeakers. Users play a calibrated test signal through their speakers, capture the response with a microphone, and receive a personalized equalization curve that compensates for room acoustics.

**Current Features**:

- Logarithmic sine sweep generation (20 Hz – 20 kHz)
- Real-time frequency response visualization
- Configurable measurement duration and averaging
- Smoothing options (1/3 octave, 1/6 octave, raw)
- Export to multiple EQ formats
- Multi-point measurement support for room averaging

**Target Users**: Home audio enthusiasts, podcasters, small studio operators, and anyone seeking improved speaker performance without professional equipment.

### Future Product Line

AcousticForge plans to expand beyond room calibration into a comprehensive suite of audio tools:

#### 1. spectrum-analyzer
A professional-grade real-time spectrum analyzer with multiple display modes (FFT, spectrogram, waterfall), customizable resolution, and RMS/peak hold capabilities. Suitable for live sound monitoring, acoustic analysis, and educational purposes.

#### 2. impulse-response-tool
A dedicated impulse response measurement and editing suite. Features include windowing, deconvolution, time-alignment, and convolution filter generation for speaker and room correction.

#### 3. acoustic-mapper
A spatial acoustic mapping tool that guides users through systematic room measurements and generates comprehensive acoustic reports. Includes visualization of modal distribution, reverb time (RT60), and early reflection identification.

#### 4. eq-processor
A standalone parametric equalizer that loads and applies generated correction profiles. Features include per-band frequency, gain, and Q controls, multiple filter shapes, and real-time spectrum overlay.

#### 5. cross-platform-desktop
Native desktop applications (Electron/Tauri) for platforms where browser-based audio has limitations. Provides ASIO/CoreAudio support for lower-latency operation and tighter system integration.

---

## Future Roadmap

Our roadmap reflects our commitment to building tools the community needs most. Priorities are determined by community feedback, technical feasibility, and alignment with our mission.

### Phase 1: Foundation (Current)

- [x] Core DSP engine implementation
- [x] Basic sine sweep measurement workflow
- [x] Frequency response visualization
- [x] Profile export functionality

### Phase 2: Measurement Enhancement (Near-term)

- [ ] Multi-point measurement averaging with position weighting
- [ ] Automated measurement sequence for unattended collection
- [ ] Microphone calibration file support (compensation curves)
- [ ] Reference microphone integration (MiniDSP UMIK-1, Dayton EM-800)
- [ ] Measurement persistence and comparison history

### Phase 3: Advanced Processing (Mid-term)

- [ ] Phase correction and minimum-phase transform
- [ ] Subwoofer integration with delay and level matching
- [ ] Crossover optimization for multi-driver systems
- [ ] Dynamic range compression for consistent playback levels
- [ ] Custom target curves (e.g., house curve, ANSI/CTA-2015)

### Phase 4: Platform Expansion (Long-term)

- [ ] Native desktop applications with low-latency audio
- [ ] Mobile companion app for measurement guidance
- [ ] Cloud-based measurement analysis (optional, privacy-respecting)
- [ ] Plugin formats (VST, AU, AAX) for DAW integration

### Community-Driven Priorities

The roadmap is not fixed. We actively solicit input from our community on:

- New feature requests and prioritization
- Platform support decisions
- Documentation improvements
- Integration with third-party tools

---

## Contributing

AcousticForge welcomes contributions from audio engineers, developers, and enthusiasts. Whether you are a DSP expert, a UI designer, or someone who simply wants to report a bug, your contributions make the project better.

### How to Contribute

1. **Report Issues**: Help us identify bugs and feature gaps by opening detailed issue reports.
2. **Submit Code**: Fork the repository, implement features or fixes, and submit pull requests.
3. **Improve Documentation**: Good documentation is critical for adoption—help us make it better.
4. **Share Your Measurements**: Anonymized measurement data helps us improve our algorithms.
5. **Spread the Word**: Share AcousticForge with your network and help grow our community.

### Code of Conduct

We are committed to a welcoming, inclusive environment. All contributors are expected to adhere to our code of conduct, which promotes respectful discourse and collaborative development.

---

## License

All AcousticForge packages are licensed under the **MIT License**, a permissive open-source license that allows commercial use, modification, distribution, and private use. This ensures our software remains free and open forever.

---

*Sound tailored to your space. Open source for everyone.*