#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  bgGreen: '\x1b[42m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
  bgCyan: '\x1b[46m',
};

function formatVietnameseDateTime(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('vi-VN', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Asia/Ho_Chi_Minh',
    hour12: false
  });
  return formatter.format(date);
}

class DeploymentLogger {
  constructor(environments = []) {
    this.steps = [];
    this.currentStepIndex = -1;
    this.startTime = Date.now();
    this.lastRenderTime = 0;
    this.renderThrottle = 100;
    this.environments = environments.length > 0 ? environments : ['default'];
    this.stepMatrix = {};
  }

  addStep(name, description = '') {
    const step = {
      name,
      description,
      status: 'pending',
      message: '',
      startTime: null,
      endTime: null,
      duration: null
    };
    this.steps.push(step);
    const stepIndex = this.steps.length - 1;
    
    // Initialize matrix entry for this step
    this.stepMatrix[stepIndex] = {};
    this.environments.forEach(env => {
      this.stepMatrix[stepIndex][env] = {
        status: 'pending',
        message: '',
        startTime: null,
        endTime: null,
        duration: null
      };
    });
    
    return stepIndex;
  }

  findStep(name) {
    if (!name) return -1;
    
    // Exact match first
    let index = this.steps.findIndex(s => s.name === name);
    if (index >= 0) return index;
    
    // Normalize names (remove everything after colon for matching)
    const normalize = (str) => {
      if (!str) return '';
      // Remove everything after the last colon (e.g., "R2 Bucket: name" -> "R2 Bucket")
      const parts = str.split(':');
      return parts[0].trim().toLowerCase();
    };
    const nameNormalized = normalize(name);
    if (!nameNormalized) return -1;
    
    // Try prefix match (e.g., "[Cloudflare] R2 Bucket: xxx" matches "[Cloudflare] R2 Bucket")
    index = this.steps.findIndex(s => {
      const stepNormalized = normalize(s.name);
      return stepNormalized === nameNormalized && stepNormalized.length > 0;
    });
    if (index >= 0) return index;
    
    // Try reverse match - check if step name (without colon) matches the normalized name
    index = this.steps.findIndex(s => {
      const stepNormalized = normalize(s.name);
      return stepNormalized === nameNormalized;
    });
    if (index >= 0) return index;
    
    // Try contains match (for flexible matching)
    index = this.steps.findIndex(s => {
      const stepKey = normalize(s.name);
      if (!stepKey || !nameNormalized) return false;
      return nameNormalized.includes(stepKey) || stepKey.includes(nameNormalized);
    });
    
    return index;
  }

  startStep(nameOrIndex, message = '', envName = null) {
    const index = typeof nameOrIndex === 'number' ? nameOrIndex : this.findStep(nameOrIndex);
    if (index >= 0 && index < this.steps.length) {
      const targetEnv = envName || this.environments[0];
      if (this.stepMatrix[index] && this.stepMatrix[index][targetEnv]) {
        this.stepMatrix[index][targetEnv].status = 'running';
        this.stepMatrix[index][targetEnv].message = message;
        this.stepMatrix[index][targetEnv].startTime = Date.now();
      }
      this.currentStepIndex = index;
      this.render();
    }
  }

  completeStep(nameOrIndex, message = '', envName = null) {
    const index = typeof nameOrIndex === 'number' ? nameOrIndex : this.findStep(nameOrIndex);
    if (index >= 0 && index < this.steps.length) {
      const targetEnv = envName || this.environments[0];
      if (this.stepMatrix[index] && this.stepMatrix[index][targetEnv]) {
        this.stepMatrix[index][targetEnv].status = 'completed';
        this.stepMatrix[index][targetEnv].message = message || this.stepMatrix[index][targetEnv].message;
        this.stepMatrix[index][targetEnv].endTime = Date.now();
        if (this.stepMatrix[index][targetEnv].startTime) {
          this.stepMatrix[index][targetEnv].duration = this.stepMatrix[index][targetEnv].endTime - this.stepMatrix[index][targetEnv].startTime;
        }
      }
      this.render();
    }
  }

  failStep(nameOrIndex, message = '', envName = null) {
    const index = typeof nameOrIndex === 'number' ? nameOrIndex : this.findStep(nameOrIndex);
    if (index >= 0 && index < this.steps.length) {
      const targetEnv = envName || this.environments[0];
      if (this.stepMatrix[index] && this.stepMatrix[index][targetEnv]) {
        this.stepMatrix[index][targetEnv].status = 'failed';
        this.stepMatrix[index][targetEnv].message = message || this.stepMatrix[index][targetEnv].message;
        this.stepMatrix[index][targetEnv].endTime = Date.now();
        if (this.stepMatrix[index][targetEnv].startTime) {
          this.stepMatrix[index][targetEnv].duration = this.stepMatrix[index][targetEnv].endTime - this.stepMatrix[index][targetEnv].startTime;
        }
      }
      this.render();
    }
  }

  warnStep(nameOrIndex, message = '', envName = null) {
    const index = typeof nameOrIndex === 'number' ? nameOrIndex : this.findStep(nameOrIndex);
    if (index >= 0 && index < this.steps.length) {
      const targetEnv = envName || this.environments[0];
      if (this.stepMatrix[index] && this.stepMatrix[index][targetEnv]) {
        if (this.stepMatrix[index][targetEnv].status === 'pending') {
          this.stepMatrix[index][targetEnv].status = 'running';
        }
        this.stepMatrix[index][targetEnv].message = message || this.stepMatrix[index][targetEnv].message;
      }
      this.render();
    }
  }

  skipStep(nameOrIndex, message = '') {
    const index = typeof nameOrIndex === 'number' ? nameOrIndex : this.findStep(nameOrIndex);
    if (index >= 0 && index < this.steps.length) {
      this.steps[index].status = 'skipped';
      this.steps[index].message = message || 'Skipped';
      this.render();
    }
  }

  getStatusIcon(status) {
    switch (status) {
      case 'completed': return `${colors.green}${colors.bright}✓${colors.reset}`;
      case 'failed': return `${colors.red}${colors.bright}✗${colors.reset}`;
      case 'running': return `${colors.cyan}${colors.bright}⟳${colors.reset}`;
      case 'warning': return `${colors.yellow}${colors.bright}⚠${colors.reset}`;
      case 'skipped': return `${colors.green}${colors.bright}⊘${colors.reset}`;
      case 'pending': return `${colors.dim}○${colors.reset}`;
      default: return ' ';
    }
  }

  getStatusText(status) {
    switch (status) {
      case 'completed': return `${colors.green}${colors.bright}COMPLETED${colors.reset}`;
      case 'failed': return `${colors.red}${colors.bright}FAILED${colors.reset}`;
      case 'running': return `${colors.cyan}${colors.bright}RUNNING${colors.reset}`;
      case 'warning': return `${colors.yellow}${colors.bright}WARNING${colors.reset}`;
      case 'skipped': return `${colors.green}${colors.bright}SKIPPED${colors.reset}`;
      case 'pending': return `${colors.dim}PENDING${colors.reset}`;
      default: return '';
    }
  }

  formatDuration(ms) {
    if (!ms) return '';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  render() {
    const now = Date.now();
    // Always render if enough time has passed, or if there are running steps
    const hasRunning = this.steps.some((step, index) => {
      if (!this.stepMatrix[index]) return false;
      return Object.values(this.stepMatrix[index]).some(cell => cell && cell.status === 'running');
    });
    
    // Throttle rendering only if there are running steps and not enough time passed
    if (hasRunning && now - this.lastRenderTime < this.renderThrottle) {
      return;
    }
    this.lastRenderTime = now;

    process.stdout.write('\x1b[2J\x1b[0f');
    
    const headerWidth = 100;
    const title = '🚀 AI FaceSwap Cloudflare Backend - Deployment';
    const titlePadding = Math.max(0, headerWidth - title.length - 4);
    const header = `${colors.bright}${colors.cyan}╔${'═'.repeat(headerWidth - 2)}╗${colors.reset}\n` +
                   `${colors.bright}${colors.cyan}║${colors.reset} ${colors.bright}${colors.white}${title}${colors.reset}${' '.repeat(titlePadding)}${colors.bright}${colors.cyan}║${colors.reset}\n` +
                   `${colors.bright}${colors.cyan}╚${'═'.repeat(headerWidth - 2)}╝${colors.reset}\n`;

    process.stdout.write(header);

    this.renderMatrix();

    const elapsed = Date.now() - this.startTime;
    const elapsedText = `${colors.bright}Elapsed:${colors.reset} ${this.formatDuration(elapsed)}\n`;
    process.stdout.write(elapsedText);
    process.stdout.write('\n');
  }

  renderMatrix() {
    // Calculate dynamic widths based on actual content
    let maxStepNameWidth = 4; // Minimum: "STEP" header
    let maxEnvNameWidth = 0;
    let maxStatusWidth = 0;
    let maxMessageWidth = 0;
    
    // Find longest step name
    this.steps.forEach(step => {
      const cleanStepName = this.stripAnsiCodes(step.name || '');
      maxStepNameWidth = Math.max(maxStepNameWidth, cleanStepName.length);
    });
    
    // Find longest environment name
    this.environments.forEach(env => {
      const cleanEnvName = this.stripAnsiCodes(env || '');
      maxEnvNameWidth = Math.max(maxEnvNameWidth, cleanEnvName.length);
    });
    
    // Find longest status text and message across all cells
    this.steps.forEach((step, stepIndex) => {
      this.environments.forEach(env => {
        const cellData = this.stepMatrix[stepIndex] && this.stepMatrix[stepIndex][env] 
          ? this.stepMatrix[stepIndex][env] 
          : { status: 'pending', message: '' };
        
        const statusText = this.getStatusTextShort(cellData.status);
        const cleanStatusText = this.stripAnsiCodes(statusText);
        maxStatusWidth = Math.max(maxStatusWidth, cleanStatusText.length);
        
        const cleanMessage = this.stripAnsiCodes(cellData.message || '');
        maxMessageWidth = Math.max(maxMessageWidth, cleanMessage.length);
      });
    });
    
    // Calculate step number column width (e.g., "10" = 2 chars)
    const stepNumColWidth = Math.max(String(this.steps.length).length + 1, 3); // number + space, minimum 3
    
    // Set column widths with padding
    const stepColWidth = Math.max(maxStepNameWidth + 2, 10); // Add 2 for padding, minimum 10
    const envColWidth = Math.max(
      maxEnvNameWidth + 2,
      maxStatusWidth + 2,
      maxMessageWidth + 2,
      10 // Minimum 10
    );
    
    // Header row - wrap environment names if needed
    const envHeaderLines = this.environments.map(env => {
      const envLines = this.wrapText(env, envColWidth);
      // Return first 2 lines for header display (environment names are usually short)
      return [envLines[0] || '', envLines[1] || ''];
    });
    
    // Top border with proper corners
    const topBorder = `${colors.dim}╔${'═'.repeat(stepNumColWidth)}╦${'═'.repeat(stepColWidth)}╦${this.environments.map(() => '═'.repeat(envColWidth)).join('╦')}╗${colors.reset}\n`;
    
    // Header line 1 - calculate fixed width with ANSI code handling
    const stepNumHeader = '';
    const stepNumHeaderPadded = stepNumHeader + ' '.repeat(Math.max(0, stepNumColWidth - stepNumHeader.length));
    const stepHeaderText = 'STEP';
    const stepHeaderPadded = stepHeaderText + ' '.repeat(Math.max(0, stepColWidth - stepHeaderText.length));
    let headerRow = `${colors.dim}║${colors.reset}${colors.bright}${stepNumHeaderPadded}${colors.reset}${colors.dim}║${colors.reset}${colors.bright}${stepHeaderPadded}${colors.reset}${colors.dim}║${colors.reset}`;
    envHeaderLines.forEach((lines, idx) => {
      const cleanEnvLine1 = this.stripAnsiCodes(lines[0] || '');
      const envLine1Padded = (lines[0] || '') + ' '.repeat(Math.max(0, envColWidth - cleanEnvLine1.length));
      headerRow += `${colors.bright}${envLine1Padded}${colors.reset}${colors.dim}║${colors.reset}`;
    });
    headerRow += '\n';
    
    const separator = `${colors.dim}╠${'═'.repeat(stepNumColWidth)}╬${'═'.repeat(stepColWidth)}╬${this.environments.map(() => '═'.repeat(envColWidth)).join('╬')}╣${colors.reset}\n`;
    const bottomSeparator = `${colors.dim}╚${'═'.repeat(stepNumColWidth)}╩${'═'.repeat(stepColWidth)}╩${this.environments.map(() => '═'.repeat(envColWidth)).join('╩')}╝${colors.reset}\n`;
    const rowSeparator = `${colors.dim}╟${'─'.repeat(stepNumColWidth)}╫${'─'.repeat(stepColWidth)}╫${this.environments.map(() => '─'.repeat(envColWidth)).join('╫')}╢${colors.reset}\n`;
    
    process.stdout.write(topBorder);
    process.stdout.write(headerRow);
    // Header line 2 (if any env names wrapped)
    const hasHeaderLine2 = envHeaderLines.some(lines => lines[1]);
    if (hasHeaderLine2) {
      const emptyStepNum = ' '.repeat(stepNumColWidth);
      const emptyStepHeader = ' '.repeat(stepColWidth);
      let headerRow2 = `${colors.dim}║${colors.reset}${emptyStepNum}${colors.dim}║${colors.reset}${emptyStepHeader}${colors.dim}║${colors.reset}`;
      envHeaderLines.forEach((lines, idx) => {
        const cleanEnvLine2 = this.stripAnsiCodes(lines[1] || '');
        const envLine2Padded = (lines[1] || '') + ' '.repeat(Math.max(0, envColWidth - cleanEnvLine2.length));
        headerRow2 += `${envLine2Padded}${colors.dim}║${colors.reset}`;
      });
      headerRow2 += '\n';
      process.stdout.write(headerRow2);
    }
    process.stdout.write(separator);

    // Step rows - display full text across multiple lines if needed
    this.steps.forEach((step, index) => {
      const stepName = step.name;
      const stepDesc = step.description || '';
      const stepNumber = String(index + 1);
      const stepNumDisplay = stepNumber;
      const stepNumPadded = stepNumDisplay + ' '.repeat(Math.max(0, stepNumColWidth - stepNumDisplay.length));
      
      // Wrap step name to multiple lines (full text, no truncation)
      // Use calculated width - wrap only if text exceeds terminal width
      const terminalWidth = process.stdout.columns || 200;
      const availableWidth = terminalWidth - (envColWidth * this.environments.length) - stepNumColWidth - 10; // separators
      // Use stepColWidth (calculated from content) but don't exceed terminal width
      const effectiveStepWidth = Math.min(stepColWidth, availableWidth);
      const nameLines = this.wrapText(stepName, effectiveStepWidth);
      const maxNameLines = Math.max(nameLines.length, 1);
      
      // Render each line of the step name
      nameLines.forEach((nameLine, nameLineIndex) => {
        const cleanNameLine = this.stripAnsiCodes(nameLine || '');
        const nameLinePadded = (nameLine || '') + ' '.repeat(Math.max(0, stepColWidth - cleanNameLine.length));
        
        // Show step number only on first line
        const stepNumCell = nameLineIndex === 0 ? stepNumPadded : ' '.repeat(stepNumColWidth);
        let outputLine = `${colors.dim}║${colors.reset}${stepNumCell}${colors.dim}║${colors.reset}${nameLinePadded}${colors.dim}║${colors.reset}`;
        
        this.environments.forEach(env => {
          const cellData = this.stepMatrix[index] && this.stepMatrix[index][env] 
            ? this.stepMatrix[index][env] 
            : { status: 'pending', message: '' };
          
          if (nameLineIndex === 0) {
            // First line: show status
            const statusText = this.getStatusTextShort(cellData.status);
            const cleanText = this.stripAnsiCodes(statusText);
            const padding = Math.max(0, envColWidth - cleanText.length);
            const statusDisplay = statusText + ' '.repeat(padding);
            outputLine += statusDisplay + `${colors.dim}║${colors.reset}`;
          } else if (nameLineIndex === 1) {
            // Second line: show message (first line of message if wrapped)
            const messageLines = this.wrapText(cellData.message || '', envColWidth);
            const cleanMessageLine1 = this.stripAnsiCodes(messageLines[0] || '');
            const messageDisplay = (messageLines[0] || '') + ' '.repeat(Math.max(0, envColWidth - cleanMessageLine1.length));
            outputLine += messageDisplay + `${colors.dim}║${colors.reset}`;
          } else {
            // Additional lines: show continuation of message or empty
            const messageLines = this.wrapText(cellData.message || '', envColWidth);
            const messageLineIndex = nameLineIndex - 1;
            const cleanMessageLine = this.stripAnsiCodes(messageLines[messageLineIndex] || '');
            const messageDisplay = (messageLines[messageLineIndex] || '') + ' '.repeat(Math.max(0, envColWidth - cleanMessageLine.length));
            outputLine += messageDisplay + `${colors.dim}║${colors.reset}`;
          }
        });
        
        process.stdout.write(outputLine + '\n');
      });
      
      // If step name was only 1 line, add a second line for messages
      if (nameLines.length === 1) {
        let messageLine = `${colors.dim}║${colors.reset}${' '.repeat(stepNumColWidth)}${colors.dim}║${colors.reset}${' '.repeat(stepColWidth)}${colors.dim}║${colors.reset}`;
        this.environments.forEach(env => {
          const cellData = this.stepMatrix[index] && this.stepMatrix[index][env] 
            ? this.stepMatrix[index][env] 
            : { status: 'pending', message: '' };
          
          const messageLines = this.wrapText(cellData.message || '', envColWidth);
          const cleanMessageLine1 = this.stripAnsiCodes(messageLines[0] || '');
          const messageDisplay = (messageLines[0] || '') + ' '.repeat(Math.max(0, envColWidth - cleanMessageLine1.length));
          messageLine += messageDisplay + `${colors.dim}║${colors.reset}`;
        });
        process.stdout.write(messageLine + '\n');
      }
      
      // Use row separator between steps (except last one)
      if (index < this.steps.length - 1) {
        process.stdout.write(rowSeparator);
      }
    });

    process.stdout.write(bottomSeparator);
    
    // Summary
    const summary = this.calculateMatrixSummary();
    const progressBar = this.renderProgressBar(summary.progress);
    const summaryText = `${colors.bright}Progress:${colors.reset} ${progressBar} ${colors.bright}${summary.progress}%${colors.reset}\n` +
                    `${colors.bright}Summary:${colors.reset} ${colors.green}${summary.completed}✓${colors.reset} ` +
                    `${colors.red}${summary.failed}✗${colors.reset} ` +
                    `${colors.yellow}${summary.warning}⚠${colors.reset} ` +
                    `${colors.cyan}${summary.running}⟳${colors.reset} ` +
                    `${colors.dim}${summary.pending}○${colors.reset} ` +
                    `| ${summary.total} total\n`;
    process.stdout.write(summaryText);
  }

  wrapText(text, maxWidth) {
    if (!text) return [''];
    
    // If maxWidth is 0 or negative, return text as single line (no wrapping)
    if (maxWidth <= 0) {
      return [text];
    }
    
    // Strip ANSI codes to get actual visible length
    const cleanText = this.stripAnsiCodes(text);
    if (cleanText.length <= maxWidth) {
      return [text];
    }
    
    // Try to break at word boundary first
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';
    
    for (const word of words) {
      const cleanWord = this.stripAnsiCodes(word);
      const cleanCurrentLine = this.stripAnsiCodes(currentLine);
      
      if (cleanCurrentLine.length + (cleanCurrentLine ? 1 : 0) + cleanWord.length <= maxWidth) {
        currentLine += (currentLine ? ' ' : '') + word;
      } else {
        // Current line is full, start a new line
        if (currentLine) {
          lines.push(currentLine);
        }
        
        // Check if word itself is too long for one line
        if (cleanWord.length > maxWidth) {
          // Word is too long, break it character by character
          // Need to preserve ANSI codes when splitting
          let charCount = 0;
          let wordPart = '';
          let inAnsi = false;
          let ansiBuffer = '';
          
          for (let i = 0; i < word.length; i++) {
            const char = word[i];
            if (char === '\x1b') {
              inAnsi = true;
              ansiBuffer = char;
            } else if (inAnsi) {
              ansiBuffer += char;
              if (char === 'm') {
                inAnsi = false;
                wordPart += ansiBuffer;
                ansiBuffer = '';
              }
            } else {
              if (charCount >= maxWidth) {
                // Current word part is full, start new line
                lines.push(wordPart);
                wordPart = '';
                charCount = 0;
              }
              wordPart += char;
              charCount++;
            }
          }
          currentLine = wordPart;
        } else {
          currentLine = word;
        }
      }
    }
    
    // Add the last line if it has content
    if (currentLine) {
      lines.push(currentLine);
    }
    
    return lines.length > 0 ? lines : [''];
  }


  getStatusTextShort(status) {
    switch (status) {
      case 'completed': return `${colors.green}${colors.bright}COMPLETED${colors.reset}`;
      case 'failed': return `${colors.red}${colors.bright}FAILED${colors.reset}`;
      case 'running': return `${colors.cyan}${colors.bright}RUNNING${colors.reset}`;
      case 'warning': return `${colors.yellow}${colors.bright}WARNING${colors.reset}`;
      case 'skipped': return `${colors.green}${colors.bright}SKIPPED${colors.reset}`;
      case 'pending': return `${colors.dim}PENDING${colors.reset}`;
      default: return `${colors.dim}PENDING${colors.reset}`;
    }
  }

  // Strip ANSI color codes to get actual text length
  stripAnsiCodes(text) {
    return text.replace(/\x1b\[[0-9;]*m/g, '');
  }

  calculateMatrixSummary() {
    let completed = 0, failed = 0, running = 0, warning = 0, pending = 0, total = 0;
    
    this.steps.forEach((step, index) => {
      this.environments.forEach(env => {
        const cellData = this.stepMatrix[index] && this.stepMatrix[index][env] 
          ? this.stepMatrix[index][env] 
          : { status: 'pending' };
        
        total++;
        switch (cellData.status) {
          case 'completed': completed++; break;
          case 'failed': failed++; break;
          case 'running': running++; break;
          case 'warning': warning++; break;
          default: pending++; break;
        }
      });
    });
    
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { completed, failed, running, warning, pending, total, progress };
  }

  renderProgressBar(percentage) {
    const width = 40;
    const filled = Math.round((percentage / 100) * width);
    const empty = width - filled;
    return `${colors.green}${'█'.repeat(filled)}${colors.reset}${colors.dim}${'░'.repeat(empty)}${colors.reset}`;
  }

  renderSummary(results = {}) {
    const allCompleted = this.steps.every(s => s.status === 'completed' || s.status === 'skipped' || s.status === 'warning');
    const hasFailures = this.steps.some(s => s.status === 'failed');

    process.stdout.write('\n');
    const summaryWidth = 100;
    const summaryTitle = '📊 Deployment Summary';
    const summaryPadding = Math.max(0, summaryWidth - summaryTitle.length - 4);
    process.stdout.write(`${colors.bright}${colors.cyan}╔${'═'.repeat(summaryWidth - 2)}╗${colors.reset}\n`);
    process.stdout.write(`${colors.bright}${colors.cyan}║${colors.reset} ${colors.bright}${colors.white}${summaryTitle}${colors.reset}${' '.repeat(summaryPadding)}${colors.bright}${colors.cyan}║${colors.reset}\n`);
    process.stdout.write(`${colors.bright}${colors.cyan}╚${'═'.repeat(summaryWidth - 2)}╝${colors.reset}\n`);
    process.stdout.write('\n');

    if (allCompleted && !hasFailures) {
      process.stdout.write(`${colors.green}${colors.bright}✓ Deployment completed successfully!${colors.reset}\n\n`);
      
      if (results.workerUrl) {
        process.stdout.write(`${colors.bright}Backend Worker:${colors.reset} ${colors.cyan}${results.workerUrl}${colors.reset}\n`);
      }
      if (results.pagesUrl) {
        process.stdout.write(`${colors.bright}Frontend Pages:${colors.reset} ${colors.cyan}${results.pagesUrl}${colors.reset}\n`);
      }
    } else if (hasFailures) {
      process.stdout.write(`${colors.red}${colors.bright}✗ Deployment failed!${colors.reset}\n\n`);
      const failedSteps = this.steps.filter(s => s.status === 'failed');
      failedSteps.forEach(step => {
        process.stdout.write(`${colors.red}  ✗ ${step.name}: ${step.message}${colors.reset}\n`);
      });
    }

    process.stdout.write('\n');
  }
}

let logger = null;

function initLogger() {
  logger = new DeploymentLogger();
  return logger;
}

function logStep(message, envName = null) {
  const prefix = envName ? `[${envName}] ` : '';
  if (logger) {
    const index = logger.addStep(message);
    logger.startStep(index);
  } else {
    console.log(`${colors.cyan}[STEP]${colors.reset} ${prefix}${message}`);
  }
}

function logSuccess(message, envName = null) {
  const prefix = envName ? `[${envName}] ` : '';
  if (logger && logger.currentStepIndex >= 0) {
    logger.completeStep(logger.currentStepIndex, message);
  } else {
    console.log(`${colors.green}✓${colors.reset} ${prefix}${message}`);
  }
}

function logError(message, envName = null) {
  const prefix = envName ? `[${envName}] ` : '';
  if (logger && logger.currentStepIndex >= 0) {
    logger.failStep(logger.currentStepIndex, message);
  } else {
    console.log(`${colors.red}✗${colors.reset} ${prefix}${message}`);
  }
}

function logWarn(message, envName = null) {
  const prefix = envName ? `[${envName}] ` : '';
  if (logger && logger.currentStepIndex >= 0) {
    logger.warnStep(logger.currentStepIndex, message);
  } else {
    console.log(`${colors.yellow}⚠${colors.reset} ${prefix}${message}`);
  }
}

function logCriticalError(message) {
  const border = `${colors.bright}${colors.red}${'═'.repeat(80)}${colors.reset}`;
  const critical = `${colors.bright}${colors.red}${colors.bgRed}${colors.white} ⚠ CRITICAL CONFIGURATION ERROR - DEPLOYMENT ABORTED ⚠ ${colors.reset}`;
  console.error('\n' + border);
  console.error(critical);
  console.error(border);
  console.error(`${colors.bright}${colors.red}${message}${colors.reset}`);
  console.error(border + '\n');
}

function validateEnvironmentConfig(config, expectedEnvName) {
  if (!config) {
    throw new Error(`Environment validation failed: Config is null or undefined. Deployment ABORTED to prevent cross-environment deployment.`);
  }
  
  if (config._environment !== expectedEnvName) {
    throw new Error(`Environment validation failed: Config environment '${config._environment}' does not match expected '${expectedEnvName}'. Deployment ABORTED to prevent cross-environment deployment.`);
  }
  
  if (!config.workerName || config.workerName.trim() === '') {
    throw new Error(`Environment validation failed: workerName is missing or empty. Deployment ABORTED to prevent cross-environment deployment.`);
  }
  
  if (!config.pagesProjectName || config.pagesProjectName.trim() === '') {
    throw new Error(`Environment validation failed: pagesProjectName is missing or empty. Deployment ABORTED to prevent cross-environment deployment.`);
  }
  
  if (!config.cloudflare || !config.cloudflare.accountId || config.cloudflare.accountId.trim() === '') {
    throw new Error(`Environment validation failed: cloudflare.accountId is missing or empty. Deployment ABORTED to prevent cross-environment deployment.`);
  }
  
  if (!config.cloudflare.apiToken || config.cloudflare.apiToken.trim() === '') {
    throw new Error(`Environment validation failed: cloudflare.apiToken is missing or empty. Deployment ABORTED to prevent cross-environment deployment.`);
  }
  
  if (!config.databaseName || config.databaseName.trim() === '') {
    throw new Error(`Environment validation failed: databaseName is missing or empty. Deployment ABORTED to prevent cross-environment deployment.`);
  }
  
  if (!config.bucketName || config.bucketName.trim() === '') {
    throw new Error(`Environment validation failed: bucketName is missing or empty. Deployment ABORTED to prevent cross-environment deployment.`);
  }
}

function execCommand(command, options = {}) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: options.silent ? 'pipe' : 'inherit', ...options });
  } catch (error) {
    if (options.throwOnError !== false) throw error;
    return null;
  }
}

function runCommand(command, cwd) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    const child = spawn(command, [], { 
      cwd: cwd || process.cwd(), 
      shell: true, 
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env
    });
    let stdout = '', stderr = '', answered = false;

    const answerPrompt = (output) => {
      if (answered) return;
      const full = (stdout + stderr + output).toLowerCase();
      const prompts = [
        'ok to proceed?',
        'continue?',
        'proceed?',
        'yes/no',
        'y/n',
        'unavailable',
        'this process may take some time',
        'are you sure',
        'confirm',
        'press enter',
        'press any key',
        'do you want to',
        'would you like to'
      ];
      
      if (prompts.some(prompt => full.includes(prompt))) {
        if (full.includes('y/n') || full.includes('yes/no')) {
          child.stdin.write('y\n');
        } else if (full.includes('press enter') || full.includes('press any key')) {
          child.stdin.write('\n');
        } else {
          child.stdin.write('yes\n');
        }
        answered = true;
      }
    };

    child.stdout.on('data', (data) => {
      const output = data.toString();
      stdout += output;
      answerPrompt(output);
    });

    child.stderr.on('data', (data) => {
      const output = data.toString();
      stderr += output;
      answerPrompt(output);
    });

    child.on('close', (code) => {
      const result = { success: code === 0, stdout, stderr, exitCode: code, error: code !== 0 ? stderr || stdout : null };
      result.success ? resolve(result) : reject(new Error(result.error || `Command failed with code ${code}`));
    });

    child.on('error', reject);
  });
}

async function runCommandWithRetry(command, cwd, maxRetries = 3, retryDelay = 2000) {
  let lastError;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await runCommand(command, cwd);
    } catch (error) {
      lastError = error;
      const errorMsg = error.message || error.error || '';
      const isRetryable = errorMsg.includes('timeout') || 
                         errorMsg.includes('network') || 
                         errorMsg.includes('temporary') ||
                         errorMsg.includes('rate limit') ||
                         errorMsg.includes('429');
      
      if (i < maxRetries && isRetryable) {
        await new Promise(resolve => setTimeout(resolve, retryDelay * (i + 1)));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

function restoreEnv(origToken, origAccountId) {
  if (origToken !== undefined) process.env.CLOUDFLARE_API_TOKEN = origToken;
  else delete process.env.CLOUDFLARE_API_TOKEN;
  if (origAccountId !== undefined) process.env.CLOUDFLARE_ACCOUNT_ID = origAccountId;
  else delete process.env.CLOUDFLARE_ACCOUNT_ID;
}

async function loadConfig() {
  const secretsPath = path.join(process.cwd(), '_deploy-cli-cloudflare-gcp', 'deployments-secrets.json');

  if (!fs.existsSync(secretsPath)) {
    logError('_deploy-cli-cloudflare-gcp/deployments-secrets.json not found. Please create it with your configuration.');
    process.exit(1);
  }

  try {
    const content = fs.readFileSync(secretsPath, 'utf8');
    let parsedContent;
    try {
      parsedContent = JSON.parse(content);
    } catch (parseError) {
      const errorMessage = `Invalid JSON in deployments-secrets.json: ${parseError.message}`;
      logCriticalError(errorMessage);
      process.exit(1);
    }
    
    let config = parseConfig(parsedContent);

    if (config._needsCloudflareSetup) {
      logWarn('Cloudflare credentials missing, setting up...');
      await setupCloudflare(config._environment);
      const newContent = fs.readFileSync(secretsPath, 'utf8');
      try {
        parsedContent = JSON.parse(newContent);
      } catch (parseError) {
        const errorMessage = `Invalid JSON in deployments-secrets.json after Cloudflare setup: ${parseError.message}`;
        logCriticalError(errorMessage);
        process.exit(1);
      }
      config = parseConfig(parsedContent);
      logSuccess('Cloudflare credentials configured');
    }

    return config;
  } catch (error) {
    // If it's already a critical error, it was already displayed
    if (error.message && (error.message.includes('Invalid numeric') || error.message.includes('Invalid rateLimiter'))) {
      // Error already displayed by logCriticalError
    } else {
      logCriticalError(`Configuration validation failed: ${error.message}`);
    }
    process.exit(1);
  }
}

function parseConfig(config) {
  const env = process.env.DEPLOY_ENV || 'production';
  if (config.environments) {
    config = config.environments[env];
    if (!config) throw new Error(`Environment '${env}' not found`);
  }

  const required = [
    'workerName', 'pagesProjectName', 'databaseName', 'bucketName', 'gcp',
    'RAPIDAPI_KEY', 'RAPIDAPI_HOST', 'RAPIDAPI_ENDPOINT',
    'GOOGLE_VISION_API_KEY', 'GOOGLE_VERTEX_PROJECT_ID', 'GOOGLE_VERTEX_LOCATION',
    'GOOGLE_VISION_ENDPOINT'
  ];

  const missing = required.filter(field => !config[field]);
  if (missing.length) throw new Error(`Missing fields: ${missing.join(', ')}`);

  // Strict validation for numeric configuration values
  const numericFields = {
    RESULT_MAX_HISTORY: { min: 1, max: 10000, default: 10 },
    SELFIE_MAX_FACESWAP: { min: 1, max: 1000, default: 5 },
    SELFIE_MAX_WEDDING: { min: 1, max: 1000, default: 2 },
    SELFIE_MAX_4K: { min: 1, max: 1000, default: 1 },
    SELFIE_MAX_OTHER: { min: 1, max: 1000, default: 1 }
  };

  const numericValidationErrors = [];
  for (const [fieldName, constraints] of Object.entries(numericFields)) {
    if (config[fieldName] !== undefined && config[fieldName] !== null) {
      const value = String(config[fieldName]).trim();
      const numValue = Number(value);
      
      // Check if it's a valid number
      if (value === '' || isNaN(numValue) || !isFinite(numValue)) {
        numericValidationErrors.push(`${fieldName}: "${config[fieldName]}" is not a valid number`);
        continue;
      }
      
      // Check if it's an integer
      if (!Number.isInteger(numValue)) {
        numericValidationErrors.push(`${fieldName}: "${config[fieldName]}" must be an integer (whole number)`);
        continue;
      }
      
      // Check if it's within valid range
      if (numValue < constraints.min || numValue > constraints.max) {
        numericValidationErrors.push(`${fieldName}: "${config[fieldName]}" must be between ${constraints.min} and ${constraints.max}`);
        continue;
      }
      
      // Check if it's positive
      if (numValue <= 0) {
        numericValidationErrors.push(`${fieldName}: "${config[fieldName]}" must be a positive number (greater than 0)`);
        continue;
      }
    }
  }

  if (numericValidationErrors.length > 0) {
    const errorMessage = `Invalid numeric configuration values in deployments-secrets.json:\n  - ${numericValidationErrors.join('\n  - ')}\n\nPlease fix these values before deployment.`;
    logCriticalError(errorMessage);
    throw new Error(errorMessage);
  }

  config.cloudflare = config.cloudflare || {};
  const hasCloudflare = config.cloudflare.accountId && config.cloudflare.apiToken &&
                       !config.cloudflare.accountId.includes('your_') &&
                       !config.cloudflare.apiToken.includes('your_');

  if (!hasCloudflare) {
    config._needsCloudflareSetup = true;
    config._environment = env;
  }

  if (!config.gcp?.projectId || !config.gcp?.private_key || !config.gcp?.client_email) {
    throw new Error('Invalid GCP configuration');
  }

  const hasBackendDomain = config.BACKEND_DOMAIN && config.BACKEND_DOMAIN.trim() !== '';
  let workerDevUrl = null;
  
  if (config.cloudflare.accountId && !hasBackendDomain) {
    try {
      const whoami = execSync('wrangler whoami', { encoding: 'utf8', stdio: 'pipe', timeout: 5000 });
      const match = whoami.match(/([^\s]+)@/);
      if (match) {
        workerDevUrl = `https://${config.workerName}.${match[1]}.workers.dev`;
      }
    } catch {
    }
  }

  const secrets = {
    RAPIDAPI_KEY: config.RAPIDAPI_KEY,
    RAPIDAPI_HOST: config.RAPIDAPI_HOST,
    RAPIDAPI_ENDPOINT: config.RAPIDAPI_ENDPOINT,
    GOOGLE_VISION_API_KEY: config.GOOGLE_VISION_API_KEY,
    GOOGLE_VERTEX_PROJECT_ID: config.GOOGLE_VERTEX_PROJECT_ID,
    GOOGLE_VERTEX_LOCATION: config.GOOGLE_VERTEX_LOCATION,
    GOOGLE_VISION_ENDPOINT: config.GOOGLE_VISION_ENDPOINT,
    GOOGLE_SERVICE_ACCOUNT_EMAIL: config.GOOGLE_SERVICE_ACCOUNT_EMAIL || config.gcp?.client_email || (() => { throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL or gcp.client_email is required in deployments-secrets.json'); })(),
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: config.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || config.gcp?.private_key || (() => { throw new Error('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY or gcp.private_key is required in deployments-secrets.json'); })(),
    R2_BUCKET_BINDING: config.bucketName,
    D1_DATABASE_BINDING: config.databaseName
  };
  
  if (config.R2_DOMAIN?.trim()) secrets.R2_DOMAIN = config.R2_DOMAIN.trim();
  
  if (hasBackendDomain) {
    const domain = config.BACKEND_DOMAIN.trim();
    secrets.BACKEND_DOMAIN = domain.startsWith('http') ? domain : `https://${domain}`;
  } else if (workerDevUrl) {
    secrets.BACKEND_DOMAIN = workerDevUrl;
  }
  
  if (config.WAVESPEED_API_KEY) secrets.WAVESPEED_API_KEY = config.WAVESPEED_API_KEY;
  if (config.ALLOWED_ORIGINS) secrets.ALLOWED_ORIGINS = config.ALLOWED_ORIGINS;
  if (config.ENABLE_DEBUG_RESPONSE) secrets.ENABLE_DEBUG_RESPONSE = config.ENABLE_DEBUG_RESPONSE;
  if (config.RESULT_MAX_HISTORY) secrets.RESULT_MAX_HISTORY = config.RESULT_MAX_HISTORY;
  if (config.SELFIE_MAX_FACESWAP) secrets.SELFIE_MAX_FACESWAP = config.SELFIE_MAX_FACESWAP;
  if (config.SELFIE_MAX_WEDDING) secrets.SELFIE_MAX_WEDDING = config.SELFIE_MAX_WEDDING;
  if (config.SELFIE_MAX_4K) secrets.SELFIE_MAX_4K = config.SELFIE_MAX_4K;
  if (config.SELFIE_MAX_OTHER) secrets.SELFIE_MAX_OTHER = config.SELFIE_MAX_OTHER;
  if (config.DISABLE_SAFE_SEARCH !== undefined) secrets.DISABLE_SAFE_SEARCH = config.DISABLE_SAFE_SEARCH;
  if (config.SAFETY_STRICTNESS) secrets.SAFETY_STRICTNESS = config.SAFETY_STRICTNESS;
  if (config.DISABLE_VERTEX_IMAGE_GEN !== undefined) secrets.DISABLE_VERTEX_IMAGE_GEN = config.DISABLE_VERTEX_IMAGE_GEN;
  if (config.DISABLE_VISION_API !== undefined) secrets.DISABLE_VISION_API = config.DISABLE_VISION_API;
  if (config.DISABLE_4K_UPSCALER !== undefined) secrets.DISABLE_4K_UPSCALER = config.DISABLE_4K_UPSCALER;
  if (config.MOBILE_API_KEY) secrets.MOBILE_API_KEY = config.MOBILE_API_KEY;
  if (config.ENABLE_MOBILE_API_KEY_AUTH) secrets.ENABLE_MOBILE_API_KEY_AUTH = config.ENABLE_MOBILE_API_KEY_AUTH;
  if (!config.promptCacheKV || !config.promptCacheKV.namespaceName) {
    throw new Error('promptCacheKV.namespaceName is required in deployments-secrets.json');
  }
  // Binding name is a constant identifier used in worker code, not the namespace name
  secrets.PROMPT_CACHE_KV_BINDING_NAME = 'PROMPT_CACHE_KV';

  if (!config.rateLimiter) {
    throw new Error('rateLimiter is required in deployments-secrets.json');
  }

  // Validate rateLimiter fields
  const rateLimiterErrors = [];
  if (!config.rateLimiter.namespaceId || String(config.rateLimiter.namespaceId).trim() === '') {
    rateLimiterErrors.push('rateLimiter.namespaceId is required and cannot be empty');
  }
  
  if (config.rateLimiter.limit !== undefined && config.rateLimiter.limit !== null) {
    const limitValue = String(config.rateLimiter.limit).trim();
    const limitNum = Number(limitValue);
    if (limitValue === '' || isNaN(limitNum) || !isFinite(limitNum) || !Number.isInteger(limitNum) || limitNum < 1 || limitNum > 100000) {
      rateLimiterErrors.push(`rateLimiter.limit: "${config.rateLimiter.limit}" must be a valid integer between 1 and 100000`);
    }
  } else {
    rateLimiterErrors.push('rateLimiter.limit is required');
  }

  if (config.rateLimiter.period_second !== undefined && config.rateLimiter.period_second !== null) {
    const periodValue = String(config.rateLimiter.period_second).trim();
    const periodNum = Number(periodValue);
    if (periodValue === '' || isNaN(periodNum) || !isFinite(periodNum) || !Number.isInteger(periodNum) || periodNum < 1 || periodNum > 3600) {
      rateLimiterErrors.push(`rateLimiter.period_second: "${config.rateLimiter.period_second}" must be a valid integer between 1 and 3600`);
    }
  } else {
    rateLimiterErrors.push('rateLimiter.period_second is required');
  }

  if (rateLimiterErrors.length > 0) {
    const errorMessage = `Invalid rateLimiter configuration in deployments-secrets.json:\n  - ${rateLimiterErrors.join('\n  - ')}\n\nPlease fix these values before deployment.`;
    logCriticalError(errorMessage);
    throw new Error(errorMessage);
  }

  return {
    ...config,
    secrets,
    deployPages: config.deployPages || process.env.DEPLOY_PAGES === 'true',
    rateLimiter: config.rateLimiter,
    promptCacheKV: config.promptCacheKV,
    _workerDevUrl: workerDevUrl
  };
}

function generateWranglerConfig(config, skipD1 = false, databaseId = null, promptCacheNamespaceId = null, expectedWorkerName = null, expectedAccountId = null, cwd = null) {
  if (expectedWorkerName !== null && config.workerName !== expectedWorkerName) {
    throw new Error(`CRITICAL: Worker name mismatch. Expected '${expectedWorkerName}', got '${config.workerName}'. Deployment ABORTED.`);
  }
  
  if (expectedAccountId !== null && config.cloudflare?.accountId !== expectedAccountId) {
    throw new Error(`CRITICAL: Account ID mismatch. Expected '${expectedAccountId}', got '${config.cloudflare?.accountId}'. Deployment ABORTED.`);
  }
  
  let mainPath = 'backend-cloudflare-workers/index.ts';
  if (cwd) {
    const configDir = path.join(cwd, '_deploy-cli-cloudflare-gcp', 'wrangler-configs');
    const entryPoint = path.join(cwd, 'backend-cloudflare-workers', 'index.ts');
    mainPath = path.relative(configDir, entryPoint);
  }
  
  const wranglerConfig = {
    name: config.workerName,
    main: mainPath,
    compatibility_date: '2024-01-01',
    account_id: config.cloudflare?.accountId,
    r2_buckets: [{ binding: config.bucketName, bucket_name: config.bucketName }],
    observability: {
      logs: {
        enabled: true,
        head_sampling_rate: 1,
        invocation_logs: true,
        persist: true
      },
      traces: {
        enabled: false,
        head_sampling_rate: 1,
        persist: true
      }
    },
    placement: {
      mode: 'smart'
    }
  };

  if (!skipD1) {
    if (databaseId) {
      wranglerConfig.d1_databases = [{ binding: config.databaseName, database_id: databaseId }];
    } else {
      wranglerConfig.d1_databases = [{ binding: config.databaseName, database_name: config.databaseName }];
    }
  }

  // Add Cloudflare built-in rate limiter from config
  if (!config.rateLimiter) {
    throw new Error('rateLimiter is required in deployments-secrets.json');
  }
  wranglerConfig.ratelimits = [{
    name: 'RATE_LIMITER',
    namespace_id: String(config.rateLimiter.namespaceId),
    simple: {
      limit: config.rateLimiter.limit,
      period: config.rateLimiter.period_second
    }
  }];

  // Add KV namespace for prompt caching - binding name is constant, namespace name is only for creation
  if (promptCacheNamespaceId) {
    wranglerConfig.kv_namespaces = [{
      binding: 'PROMPT_CACHE_KV',
      id: promptCacheNamespaceId
    }];
  }

  // Note: Custom domains for Workers are configured separately in Cloudflare dashboard
  // Routes are not needed for custom domains - they're handled via Cloudflare's custom domain feature

  return wranglerConfig;
}


async function validateCloudflareToken(token) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: '/client/v4/user/tokens/verify',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.success && json.result);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(10000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}


async function getAccountIdFromApi(token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: '/client/v4/accounts',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          json.success && json.result?.length ? resolve(json.result[0].id) :
            reject(new Error(json.errors?.[0]?.message || 'Failed to get account ID'));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}




async function getAllEditPermissionGroups(token, accountId) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: `/client/v4/accounts/${accountId}/tokens/permission_groups`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const json = JSON.parse(data);
        if (!json.success) {
          reject(new Error(`Failed to get permission groups: ${JSON.stringify(json.errors)}`));
          return;
        }
        const allGroups = json.result || [];
        const editGroups = allGroups.filter(g => {
          const name = (g.name || '').toLowerCase();
          return name.includes('edit') || name.includes('write');
        });
        resolve(editGroups);
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

async function getTokenId(token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: '/client/v4/user/tokens/verify',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const json = JSON.parse(data);
        if (!json.success || !json.result?.id) {
          reject(new Error(`Failed to get token ID: ${JSON.stringify(json.errors || json)}`));
          return;
        }
        resolve(json.result.id);
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

async function updateTokenWithAllEditPermissions(currentToken, accountId) {
  const tokenId = await getTokenId(currentToken);
  
  // Try to get permission groups with current token
  let editGroups;
  let permissionGroupsError = null;
  try {
    editGroups = await getAllEditPermissionGroups(currentToken, accountId);
  } catch (error) {
    permissionGroupsError = error;
    // If current token can't access permission groups, try to use a working token from another environment
    // Note: Permission groups are GLOBAL (same across all Cloudflare accounts), so we can use any token
    // from any account/environment to get the list. However, the token UPDATE must be done with a token
    // that has permission to update tokens in the target account.
    logWarn('Current token cannot access permission groups, trying fallback from other environments...');
    const secretsPath = path.join(process.cwd(), '_deploy-cli-cloudflare-gcp', 'deployments-secrets.json');
    if (fs.existsSync(secretsPath)) {
      const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
      // Try to find a working token from any environment (permission groups are global, same across accounts)
      for (const envName in secrets.environments || {}) {
        const envConfig = secrets.environments[envName];
        if (envConfig?.cloudflare?.apiToken && envConfig.cloudflare.apiToken !== currentToken) {
          try {
            // Use any account ID to get permission groups (they're the same globally)
            const fallbackAccountId = envConfig.cloudflare.accountId || accountId;
            editGroups = await getAllEditPermissionGroups(envConfig.cloudflare.apiToken, fallbackAccountId);
            logSuccess(`Using permission groups from ${envName} environment (account: ${fallbackAccountId})`);
            break;
          } catch (e) {
            // Continue to next environment
          }
        }
      }
    }
    
    if (!editGroups || editGroups.length === 0) {
      throw new Error(`Cannot get permission groups. Current token error: ${permissionGroupsError.message}. Please ensure your token has access to read permission groups, or provide a working token with permission to read permission groups in another environment in deployments-secrets.json.`);
    }
  }
  
  if (editGroups.length === 0) {
    throw new Error('No edit permission groups found');
  }

  const tokenData = {
    policies: [{
      effect: 'allow',
      permission_groups: editGroups.map(g => ({ id: g.id })),
      resources: {
        [`com.cloudflare.api.account.${accountId}`]: '*'
      }
    }]
  };

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(tokenData);
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: `/client/v4/user/tokens/${tokenId}`,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${currentToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const json = JSON.parse(data);
        if (!json.success) {
          reject(new Error(`Failed to update token: ${JSON.stringify(json.errors || json)}`));
          return;
        }
        resolve(currentToken);
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(postData);
    req.end();
  });
}

async function setupCloudflare(env = null, preferredAccountId = null) {
  logWarn('Setting up Cloudflare credentials...');

  const origToken = process.env.CLOUDFLARE_API_TOKEN;
  const origAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  const secretsPath = path.join(process.cwd(), '_deploy-cli-cloudflare-gcp', 'deployments-secrets.json');
  if (!fs.existsSync(secretsPath)) {
    restoreEnv(origToken, origAccountId);
    throw new Error('deployments-secrets.json not found');
  }

  const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
  const targetEnv = env || process.env.DEPLOY_ENV || 'production';
  const envConfig = secrets.environments?.[targetEnv];
  
  if (!envConfig?.cloudflare) {
    restoreEnv(origToken, origAccountId);
    throw new Error(`No Cloudflare config found for environment: ${targetEnv}`);
  }

  const config = envConfig.cloudflare;
  let token = config.apiToken || origToken;
  let accountId = config.accountId || preferredAccountId || origAccountId;

  if (!accountId) {
    restoreEnv(origToken, origAccountId);
    throw new Error(`No account ID found for environment: ${targetEnv}`);
  }

  if (!token) {
    restoreEnv(origToken, origAccountId);
    throw new Error(`No API token found for environment: ${targetEnv}. Please add apiToken to deployments-secrets.json`);
  }

  if (config.accountId && accountId !== config.accountId) {
    logWarn(`Account ID mismatch: using ${config.accountId} from config (was: ${accountId})`);
    accountId = config.accountId;
  }

  if (config.apiToken && token !== config.apiToken) {
    logWarn(`API token mismatch: using token from config for environment: ${targetEnv}`);
    token = config.apiToken;
  }

  const isValid = await validateCloudflareToken(token);
  if (!isValid) {
    restoreEnv(origToken, origAccountId);
    throw new Error(`API token validation failed for environment: ${targetEnv}. Please check your API token in deployments-secrets.json`);
  }

  logStep('Updating API token with all edit permissions...');
  try {
    await updateTokenWithAllEditPermissions(token, accountId);
    logSuccess('Token updated with all edit permissions');
    // Re-validate token after update
    const isValidAfterUpdate = await validateCloudflareToken(token);
    if (!isValidAfterUpdate) {
      restoreEnv(origToken, origAccountId);
      throw new Error('Token validation failed after update. Please check your API token.');
    }
  } catch (error) {
    restoreEnv(origToken, origAccountId);
    throw new Error(`Failed to update token with all edit permissions: ${error.message}. Please ensure your token has "User API Tokens:Edit" permission.`);
  }

  process.env.CLOUDFLARE_API_TOKEN = token;
  process.env.CLOUDFLARE_ACCOUNT_ID = accountId;

  logSuccess(`Using API token for account ${accountId}`);

  restoreEnv(origToken, origAccountId);
  return { accountId, apiToken: token };
}

function saveCloudflareCredentials(accountId, token, env = null) {
  const secretsPath = path.join(process.cwd(), '_deploy-cli-cloudflare-gcp', 'deployments-secrets.json');
  if (!fs.existsSync(secretsPath)) return;

  const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
  const targetEnv = env || process.env.DEPLOY_ENV || 'production';

  if (!secrets.environments) secrets.environments = {};
  if (!secrets.environments[targetEnv]) secrets.environments[targetEnv] = {};
  if (!secrets.environments[targetEnv].cloudflare) secrets.environments[targetEnv].cloudflare = {};

  secrets.environments[targetEnv].cloudflare.accountId = accountId;
  secrets.environments[targetEnv].cloudflare.apiToken = token;

  fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2));
  logSuccess(`API token saved for ${targetEnv} environment`);
}

const REQUIRED_SECRETS = ['RAPIDAPI_KEY', 'RAPIDAPI_HOST', 'RAPIDAPI_ENDPOINT', 'GOOGLE_VISION_API_KEY',
                         'GOOGLE_VERTEX_PROJECT_ID', 'GOOGLE_VERTEX_LOCATION', 'GOOGLE_VISION_ENDPOINT',
                         'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY'];

function checkSecrets(existing) {
  const missing = REQUIRED_SECRETS.filter(v => !existing.includes(v));
  return { missing, allSet: missing.length === 0 };
}

function getWorkerUrl(cwd, workerName) {
  try {
    const deployments = execSync('wrangler deployments list --latest', { encoding: 'utf8', stdio: 'pipe', timeout: 10000, cwd });
    const match = deployments?.match(/https:\/\/[^\s]+\.workers\.dev/);
    if (match) return match[0];
  } catch {
    try {
      const whoami = execSync('wrangler whoami', { encoding: 'utf8', stdio: 'pipe', timeout: 10000, cwd });
      const match = whoami.match(/([^\s]+)@/);
      if (match) return `https://${workerName}.${match[1]}.workers.dev`;
    } catch {
      return '';
    }
  }
  return '';
}

function createTempFrontendCopy(cwd, envName) {
  const sourceDir = path.join(cwd, 'frontend-cloudflare-pages');
  const tempDir = path.join(cwd, `frontend-cloudflare-pages.${envName}.tmp`);
  
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Source directory ${sourceDir} does not exist`);
  }
  
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  
  fs.cpSync(sourceDir, tempDir, { recursive: true });
  return tempDir;
}

function cleanupTempFrontendCopy(tempDir) {
  if (tempDir && fs.existsSync(tempDir)) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.log(`${colors.dim}Cleaned up temp directory: ${tempDir}${colors.reset}`);
    } catch (error) {
      console.warn(`${colors.yellow}Warning: Could not clean up temp directory ${tempDir}: ${error.message}${colors.reset}`);
    }
  }
}

function updateWorkerUrlInHtml(cwd, workerUrl, config, htmlPath = null) {
  const finalHtmlPath = htmlPath || path.join(cwd, 'frontend-cloudflare-pages', 'index.html');
  if (!fs.existsSync(finalHtmlPath)) return;
  
  let content = fs.readFileSync(finalHtmlPath, 'utf8');
  
  // Determine the actual worker URL to use from config (BACKEND_DOMAIN takes priority)
  let finalWorkerUrl = workerUrl;
  if (config?.BACKEND_DOMAIN) {
    finalWorkerUrl = config.BACKEND_DOMAIN.startsWith('http')
      ? config.BACKEND_DOMAIN
      : `https://${config.BACKEND_DOMAIN}`;
    console.log(`[Deploy] Using BACKEND_DOMAIN from config: ${finalWorkerUrl}`);
  } else if (workerUrl) {
    finalWorkerUrl = workerUrl;
    console.log(`[Deploy] Using worker URL: ${finalWorkerUrl}`);
  } else {
    throw new Error('No backend URL available. Please set BACKEND_DOMAIN in deployments-secrets.json or ensure worker deployment succeeds.');
  }
  
  // Replace the placeholder {{BACKEND_URL}} or any existing WORKER_URL value
  const placeholderPattern = /let WORKER_URL\s*=\s*['"]\{\{BACKEND_URL\}\}['"];?\s*\/\/.*/g;
  const existingPattern = /let WORKER_URL\s*=\s*['"](.*?)['"];?\s*\/\/.*/g;
  const simplePattern = /let WORKER_URL\s*=\s*['"](.*?)['"];?/g;
  
  if (placeholderPattern.test(content)) {
    content = content.replace(placeholderPattern, `let WORKER_URL = '${finalWorkerUrl}'; // Injected during deployment - DO NOT MODIFY MANUALLY`);
    console.log(`[Deploy] ✓ Replaced {{BACKEND_URL}} placeholder with: ${finalWorkerUrl}`);
  } else if (existingPattern.test(content)) {
    content = content.replace(existingPattern, `let WORKER_URL = '${finalWorkerUrl}'; // Injected during deployment - DO NOT MODIFY MANUALLY`);
    console.log(`[Deploy] ✓ Updated WORKER_URL in HTML to: ${finalWorkerUrl}`);
  } else if (simplePattern.test(content)) {
    content = content.replace(simplePattern, `let WORKER_URL = '${finalWorkerUrl}'; // Injected during deployment - DO NOT MODIFY MANUALLY`);
    console.log(`[Deploy] ✓ Updated WORKER_URL in HTML to: ${finalWorkerUrl}`);
  } else {
    console.log(`[Deploy] ⚠ Could not find WORKER_URL pattern in HTML to update`);
  }
  
  // Also replace fallbackUrl constant if it exists
  const fallbackUrlPattern = /const fallbackUrl\s*=\s*['"](.*?)['"];?/g;
  if (fallbackUrlPattern.test(content)) {
    content = content.replace(fallbackUrlPattern, `const fallbackUrl = '${finalWorkerUrl}';`);
    console.log(`[Deploy] ✓ Updated fallbackUrl in HTML to: ${finalWorkerUrl}`);
  }
  
  // Inject MOBILE_API_KEY if available in config
  const mobileApiKey = config?.MOBILE_API_KEY || '';
  const mobileApiKeyPattern = /let MOBILE_API_KEY\s*=\s*['"](.*?)['"];?\s*\/\/.*/g;
  if (mobileApiKeyPattern.test(content)) {
    content = content.replace(mobileApiKeyPattern, `let MOBILE_API_KEY = '${mobileApiKey}'; // Injected during deployment - DO NOT MODIFY MANUALLY`);
    console.log(`[Deploy] ✓ Updated MOBILE_API_KEY in HTML`);
  } else {
    // Try to find and update after WORKER_URL line
    const workerUrlLinePattern = /(let WORKER_URL\s*=\s*['"](.*?)['"];?\s*\/\/.*)/;
    if (workerUrlLinePattern.test(content)) {
      content = content.replace(workerUrlLinePattern, `$1\n        let MOBILE_API_KEY = '${mobileApiKey}'; // Injected during deployment - DO NOT MODIFY MANUALLY`);
      console.log(`[Deploy] ✓ Added MOBILE_API_KEY to HTML`);
    }
  }
  
  fs.writeFileSync(finalHtmlPath, content);
  console.log(`[Deploy] ✓ Updated frontend HTML with backend URL: ${finalWorkerUrl}`);
}

// Migration functions (integrated from scripts/run-migrations.js)
async function findMigrationFiles(migrationsDir) {
  const { readdir, stat } = require('fs/promises');
  const { join } = require('path');
  
  if (!fs.existsSync(migrationsDir)) {
    return [];
  }
  
  try {
    const files = await readdir(migrationsDir);
    const migrationFiles = [];
    
    for (const file of files) {
      if ((file.endsWith('.sql') || file.endsWith('.ts')) && 
          !file.endsWith('.executed.sql') && 
          !file.endsWith('.executed.ts') && 
          !file.endsWith('.d.ts') &&
          !file.includes('_application')) {
        const fullPath = join(migrationsDir, file);
        const stats = await stat(fullPath);
        if (stats.isFile()) {
          migrationFiles.push({
            name: file,
            path: file,
            fullPath,
            type: file.endsWith('.sql') ? 'sql' : 'ts'
          });
        }
      }
    }
    
    return migrationFiles.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function runSqlMigration(migrationFile, databaseName, accountId, apiToken) {
  const { readFileSync, rename } = require('fs/promises');
  const env = { ...process.env };
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  if (apiToken) env.CLOUDFLARE_API_TOKEN = apiToken;
  
  // Use absolute path and quote it to avoid issues with spaces or special characters
  const filePath = path.resolve(migrationFile.fullPath);
  const command = `wrangler d1 execute ${databaseName} --remote --file="${filePath}" --yes`;
  
  try {
    const result = execSync(command, { 
      stdio: 'pipe',
      cwd: process.cwd(),
      env: env,
      encoding: 'utf8'
    });
    
    if (result) console.log(result);
    
    const executedPath = migrationFile.fullPath.replace('.sql', '.executed.sql');
    await rename(migrationFile.fullPath, executedPath);
    return { success: true };
  } catch (execError) {
    const stdout = (execError.stdout && typeof execError.stdout === 'string') ? execError.stdout : 
                   (execError.stdout ? execError.stdout.toString() : '');
    const stderr = (execError.stderr && typeof execError.stderr === 'string') ? execError.stderr : 
                   (execError.stderr ? execError.stderr.toString() : '');
    const errorMessage = execError.message || '';
    const errorOutput = execError.output ? execError.output.map(o => o ? o.toString() : '').join('') : '';
    const allErrorText = (stdout + stderr + errorMessage + errorOutput).toLowerCase();
    
    // Handle "Not currently importing anything" error - this can happen if wrangler is in a weird state
    if (allErrorText.includes('not currently importing') || allErrorText.includes('not currently importing anything')) {
      console.warn(`[Migration] Warning: Wrangler import state issue detected. Retrying with direct SQL execution...`);
      
      // Try reading the SQL file and executing it directly via stdin
      try {
        const sqlContent = readFileSync(migrationFile.fullPath, 'utf8');
        const directCommand = `wrangler d1 execute ${databaseName} --remote --command="${sqlContent.replace(/"/g, '\\"')}" --yes`;
        const retryResult = execSync(directCommand, {
          stdio: 'pipe',
          cwd: process.cwd(),
          env: env,
          encoding: 'utf8'
        });
        
        if (retryResult) console.log(retryResult);
        
        const executedPath = migrationFile.fullPath.replace('.sql', '.executed.sql');
        await rename(migrationFile.fullPath, executedPath);
        return { success: true };
      } catch (retryError) {
        // If direct command also fails, check if it's a duplicate column error
        const retryErrorText = ((retryError.stdout || '') + (retryError.stderr || '') + (retryError.message || '')).toLowerCase();
        const isDuplicateColumn = 
          retryErrorText.includes('duplicate column') || 
          retryErrorText.includes('duplicate column name') ||
          (retryErrorText.includes('sqlite_error') && retryErrorText.includes('duplicate')) ||
          (retryErrorText.includes('column name:') && retryErrorText.includes('duplicate')) ||
          /duplicate.*column/i.test(retryErrorText);
        
        if (isDuplicateColumn) {
          const executedPath = migrationFile.fullPath.replace('.sql', '.executed.sql');
          await rename(migrationFile.fullPath, executedPath);
          return { success: true, skipped: true, reason: 'Column already exists' };
        }
        
        // If it's still the import error, mark as skipped with a note
        if (retryErrorText.includes('not currently importing')) {
          console.warn(`[Migration] ⚠ Skipping migration ${migrationFile.name} due to wrangler import state issue. You may need to run this migration manually.`);
          return { success: false, skipped: true, reason: 'Wrangler import state issue - run manually', error: 'Not currently importing anything' };
        }
        
        throw retryError;
      }
    }
    
    const isDuplicateColumn = 
      allErrorText.includes('duplicate column') || 
      allErrorText.includes('duplicate column name') ||
      (allErrorText.includes('sqlite_error') && allErrorText.includes('duplicate')) ||
      (allErrorText.includes('column name:') && allErrorText.includes('duplicate')) ||
      /duplicate.*column/i.test(allErrorText);
    
    if (isDuplicateColumn) {
      const executedPath = migrationFile.fullPath.replace('.sql', '.executed.sql');
      await rename(migrationFile.fullPath, executedPath);
      return { success: true, skipped: true, reason: 'Column already exists' };
    }
    
    throw execError;
  }
}

async function runTsMigration(migrationFile, databaseName, accountId, apiToken, config) {
  const { rename } = require('fs/promises');
  const fs = require('fs');
  const { join } = require('path');
  const os = require('os');
  const https = require('https');
  
  console.log(`[Migration] Executing TypeScript migration: ${migrationFile.name}`);
  
  try {
    // Read the migration file to extract function name
    const migrationCode = fs.readFileSync(migrationFile.fullPath, 'utf8');
    const functionMatch = migrationCode.match(/export\s+async\s+function\s+(\w+)/);
    if (!functionMatch) {
      throw new Error('Could not find exported async function in migration file');
    }
    const functionName = functionMatch[1];
    
    // Create temporary migration runner worker
    const tempDir = join(os.tmpdir(), `migration-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    
    // Use absolute path for import
    const absoluteMigrationPath = path.resolve(migrationFile.fullPath).replace(/\\/g, '/');
    const runnerCode = `// Temporary migration runner
import { ${functionName} } from '${absoluteMigrationPath}';

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    try {
      console.log('[Migration Runner] Starting migration execution...');
      await ${functionName}({
        DB: env.${databaseName},
        R2_BUCKET: env.${config.bucketName},
        env: env
      });
      console.log('[Migration Runner] Migration completed successfully');
      return new Response(JSON.stringify({ success: true, message: 'Migration completed' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error: any) {
      console.error('[Migration Runner] Migration failed:', error);
      return new Response(JSON.stringify({ 
        success: false, 
        error: error.message,
        stack: error.stack 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
`;
    
    const runnerPath = join(tempDir, 'index.ts');
    fs.writeFileSync(runnerPath, runnerCode);
    
    // Create temporary wrangler config
    const wranglerConfig = {
      name: `migration-runner-${Date.now()}`,
      main: 'index.ts',
      compatibility_date: '2024-01-01',
      account_id: accountId,
      d1_databases: [{ binding: databaseName, database_name: databaseName }],
      r2_buckets: [{ binding: config.bucketName, bucket_name: config.bucketName }]
    };
    
    const wranglerPath = join(tempDir, 'wrangler.json');
    fs.writeFileSync(wranglerPath, JSON.stringify(wranglerConfig, null, 2));
    
    // Execute migration via wrangler dev with remote
    const env = { ...process.env };
    if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
    if (apiToken) env.CLOUDFLARE_API_TOKEN = apiToken;
    
    console.log(`[Migration] Deploying temporary migration runner...`);
    
    // Deploy the runner worker
    const deployResult = await runCommandWithRetry(
      `wrangler deploy --config "${wranglerPath}" --remote`,
      tempDir,
      2,
      3000
    );
    
    if (!deployResult.success) {
      throw new Error(`Failed to deploy migration runner: ${deployResult.error}`);
    }
    
    // Extract worker URL from deploy output
    const workerUrlMatch = deployResult.stdout?.match(/https:\/\/([^\s]+)\.workers\.dev/);
    if (!workerUrlMatch) {
      throw new Error('Could not determine worker URL from deployment');
    }
    const workerUrl = `https://${workerUrlMatch[1]}.workers.dev`;
    
    console.log(`[Migration] Executing migration via worker: ${workerUrl}`);
    
    // Call the worker to execute migration
    const executionResult = await new Promise((resolve, reject) => {
      const req = https.request(workerUrl, {
        method: 'GET',
        timeout: 300000 // 5 minutes for long migrations
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.success) {
              resolve(result);
            } else {
              reject(new Error(result.error || 'Migration execution failed'));
            }
          } catch (e) {
            reject(new Error(`Invalid response: ${data}`));
          }
        });
      });
      
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Migration execution timeout'));
      });
      
      req.end();
    });
    
    // Clean up: delete the temporary worker
    try {
      await runCommand(`wrangler delete ${wranglerConfig.name} --config "${wranglerPath}"`, tempDir);
    } catch (e) {
      console.warn(`[Migration] Could not delete temporary worker: ${e.message}`);
    }
    
    // Clean up temp files
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
    
    // Mark as executed
    const executedPath = migrationFile.fullPath.replace('.ts', '.executed.ts');
    await rename(migrationFile.fullPath, executedPath);
    
    console.log(`[Migration] ✓ TS migration executed successfully: ${migrationFile.name}`);
    return { success: true };
    
  } catch (error) {
    console.error(`[Migration] ✗ TS migration failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function runMigrations(config, cwd, accountId, apiToken) {
  const { join } = require('path');
  const migrationsDir = join(cwd, 'backend-cloudflare-workers', 'migrations');
  
  if (!fs.existsSync(migrationsDir)) {
    return { success: true, count: 0, executed: 0, skipped: 0, message: 'No migrations directory found - skipping migrations' };
  }
  
  try {
    const migrationFiles = await findMigrationFiles(migrationsDir);
    
    if (migrationFiles.length === 0) {
      return { success: true, count: 0, executed: 0, skipped: 0, message: 'No pending migrations found' };
    }
    
    console.log(`[Migration] Found ${migrationFiles.length} pending migration(s):`);
    migrationFiles.forEach(f => console.log(`  - ${f.name} (${f.type})`));
    
    let executedCount = 0;
    let skippedCount = 0;
    const skippedFiles = [];
    
    for (const migrationFile of migrationFiles) {
      if (migrationFile.type === 'sql') {
        const result = await runSqlMigration(migrationFile, config.databaseName, accountId, apiToken);
        if (result.success && !result.skipped) {
          executedCount++;
          console.log(`[Migration] ✓ Executed: ${migrationFile.name}`);
        } else if (result.skipped) {
          skippedCount++;
          console.log(`[Migration] ⚠ Skipped: ${migrationFile.name} (${result.reason})`);
        }
      } else if (migrationFile.type === 'ts') {
        const result = await runTsMigration(migrationFile, config.databaseName, accountId, apiToken, config);
        if (result.success) {
          if (result.skipped) {
            // Marked as executed (SQL version exists or already executed)
            executedCount++;
            console.log(`[Migration] ✓ Marked as executed: ${migrationFile.name} (${result.reason || 'already executed'})`);
          } else {
            // Successfully executed
            executedCount++;
            console.log(`[Migration] ✓ Executed: ${migrationFile.name}`);
          }
        } else {
          skippedCount++;
          skippedFiles.push(migrationFile.name);
          console.log(`[Migration] ⚠ Skipped: ${migrationFile.name} (${result.error || result.reason})`);
        }
      }
    }
    
    let message = '';
    if (executedCount > 0 && skippedCount > 0) {
      message = `${executedCount} executed, ${skippedCount} skipped (TS migrations require manual execution)`;
    } else if (executedCount > 0) {
      message = `${executedCount} migration(s) executed`;
    } else if (skippedCount > 0) {
      message = `${skippedCount} migration(s) skipped (TS migrations require manual execution via Worker /migrate endpoint)`;
    }
    
    return { 
      success: true, 
      count: migrationFiles.length, 
      executed: executedCount, 
      skipped: skippedCount,
      skippedFiles,
      message: message || 'All migrations completed' 
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

const utils = {
  checkWrangler() {
    try {
      execSync('wrangler --version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },

  checkGcloud() {
    try {
      execSync('gcloud --version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },

  async authenticateGCP(gcpConfig) {
    const keyFile = path.join(os.tmpdir(), `gcp-key-${Date.now()}.json`);
    const serviceAccountEmail = gcpConfig.client_email;
    const projectId = gcpConfig.projectId;
    
    try {
      // Build complete service account JSON for gcloud (adds required fields)
      const completeKeyJson = {
        type: 'service_account',
        project_id: projectId,
        private_key: gcpConfig.private_key,
        client_email: gcpConfig.client_email
      };

      fs.writeFileSync(keyFile, JSON.stringify(completeKeyJson, null, 2));

      const allAccounts = execCommand('gcloud auth list --format="value(account)"', { silent: true, throwOnError: false });
      if (allAccounts) {
        const accounts = allAccounts.split('\n').filter(a => a.trim() && a.trim() !== serviceAccountEmail);
        for (const account of accounts) {
          try {
            execCommand(`gcloud auth revoke "${account.trim()}" --quiet`, { silent: true, throwOnError: false });
          } catch {
            // ignore
          }
        }
      }

      execCommand(`gcloud auth activate-service-account ${serviceAccountEmail} --key-file=${keyFile} --quiet`, { silent: true });
      execCommand(`gcloud config set project ${projectId} --quiet`, { silent: true });

      const activeAuth = execCommand('gcloud auth list --format="value(account)" --filter=status:ACTIVE', { silent: true, throwOnError: false });
      const activeProject = execCommand('gcloud config get-value project', { silent: true, throwOnError: false });

      if (!activeAuth || !activeAuth.trim().includes(serviceAccountEmail)) {
        throw new Error(`Failed to activate service account: ${serviceAccountEmail}`);
      }

      if (activeProject && activeProject.trim() !== projectId) {
        throw new Error(`Project mismatch: expected ${projectId}, got ${activeProject.trim()}`);
      }

      return true;
    } finally {
      try {
        fs.unlinkSync(keyFile);
      } catch {
        // ignore
      }
    }
  },

  async checkGCPApiEnabled(apiName, projectId) {
    try {
      const output = execCommand(
        `gcloud services list --enabled --filter="name:${apiName}" --format="value(name)" --project=${projectId}`,
        { silent: true, throwOnError: false }
      );
      return output && output.trim().includes(apiName);
    } catch {
      return false;
    }
  },

  async enableGCPApi(apiName, projectId) {
    try {
      execCommand(`gcloud services enable ${apiName} --project=${projectId} --quiet`, { silent: true });
      return true;
    } catch (error) {
      if (error.message && error.message.includes('already enabled')) {
        return true;
      }
      throw error;
    }
  },

  async ensureGCPApis(projectId) {
    const requiredApis = [
      'aiplatform.googleapis.com',
      'vision.googleapis.com'
    ];

    const apiNames = {
      'aiplatform.googleapis.com': 'Vertex AI API',
      'vision.googleapis.com': 'Vision API'
    };

    const results = {
      enabled: [],
      newlyEnabled: [],
      failed: []
    };

    const self = this;
    for (const api of requiredApis) {
      const isEnabled = await self.checkGCPApiEnabled(api, projectId);
      if (isEnabled) {
        results.enabled.push(api);
      } else {
        try {
          await self.enableGCPApi(api, projectId);
          results.newlyEnabled.push(api);
          logSuccess(`${apiNames[api]} enabled`);
        } catch (error) {
          results.failed.push({ api, error: error.message });
          logWarn(`Failed to enable ${apiNames[api]}: ${error.message}`);
        }
      }
    }

    return results;
  },

  getExistingSecrets() {
    try {
      const output = execCommand('wrangler secret list', { silent: true, throwOnError: false });
      if (!output) return [];
      return output.split('\n')
        .filter(line => line.trim() && !line.includes('Secret') && !line.includes('---'))
        .map(line => line.split(/\s+/)[0])
        .filter(Boolean);
    } catch {
      return [];
    }
  },

  async configureR2BucketCORS(bucketName, accountId, apiToken) {
    if (!bucketName || !accountId || !apiToken) {
      return { success: false, error: 'Missing required parameters' };
    }

    try {
      const https = require('https');
      
      // Configure CORS policy on R2 bucket
      const corsPolicy = [
        {
          AllowedOrigins: ['*'],
          AllowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD'],
          AllowedHeaders: ['*'],
          ExposeHeaders: ['*'],
          MaxAgeSeconds: 86400
        }
      ];

      return new Promise((resolve, reject) => {
        const putData = JSON.stringify(corsPolicy);
        const req = https.request({
          hostname: 'api.cloudflare.com',
          path: `/client/v4/accounts/${accountId}/r2/buckets/${bucketName}/cors`,
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(putData)
          },
          timeout: 15000
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.success) {
                resolve({ success: true, message: 'R2 bucket CORS configured' });
              } else {
                resolve({ success: true, message: 'R2 bucket CORS (may already be configured)' });
              }
            } catch (e) {
              resolve({ success: true, message: 'R2 bucket CORS configured' });
            }
          });
        });
        req.on('error', () => {
          resolve({ success: true, message: 'R2 bucket CORS (error ignored)' });
        });
        req.setTimeout(15000, () => { req.destroy(); resolve({ success: true, message: 'R2 bucket CORS (timeout)' }); });
        req.write(putData);
        req.end();
      });
    } catch (error) {
      return { success: true, message: `R2 bucket CORS (${error.message})` };
    }
  },

  async configureR2DomainCORS(r2Domain, accountId, apiToken) {
    if (!r2Domain || !accountId || !apiToken) {
      return { success: false, error: 'Missing required parameters' };
    }

    try {
      const https = require('https');
      const domainUrl = new URL(r2Domain.startsWith('http') ? r2Domain : `https://${r2Domain}`);
      const hostname = domainUrl.hostname;

      // Get zone ID for the domain
      const zoneId = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.cloudflare.com',
          path: `/client/v4/zones?name=${hostname}`,
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.success && json.result && json.result.length > 0) {
                resolve(json.result[0].id);
              } else {
                reject(new Error('Zone not found'));
              }
            } catch (e) {
              reject(e);
            }
          });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
      });

      // Get existing rulesets
      const rulesets = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.cloudflare.com',
          path: `/client/v4/zones/${zoneId}/rulesets`,
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve(json.result || []);
            } catch (e) {
              reject(e);
            }
          });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
      });

      // Find or create response header transform ruleset
      const rulesetPhase = 'http_response_headers_transform';
      let existingRuleset = rulesets.find(r => r.phase === rulesetPhase && r.kind === 'zone');

      const rules = [
        {
          expression: `(http.host eq "${hostname}")`,
          enabled: true,
          action: 'rewrite',
          action_parameters: {
            headers: {
              'Access-Control-Allow-Origin': { value: '*', expression: '' },
              'Access-Control-Allow-Methods': { value: 'GET, HEAD, OPTIONS', expression: '' },
              'Access-Control-Allow-Headers': { value: 'Content-Type, Range, Accept', expression: '' },
              'Access-Control-Max-Age': { value: '86400', expression: '' },
              'Access-Control-Expose-Headers': { value: 'Content-Length, Content-Range, Content-Type', expression: '' }
            }
          }
        }
      ];

      if (existingRuleset) {
        // Update existing ruleset
        return new Promise((resolve, reject) => {
          const putData = JSON.stringify({ rules });
          const req = https.request({
            hostname: 'api.cloudflare.com',
            path: `/client/v4/zones/${zoneId}/rulesets/${existingRuleset.id}/rules`,
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${apiToken}`,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(putData)
            },
            timeout: 15000
          }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                if (json.success) {
                  resolve({ success: true, message: 'CORS headers configured' });
                } else {
                  resolve({ success: true, message: 'CORS headers (may already be configured)' });
                }
              } catch (e) {
                resolve({ success: true, message: 'CORS headers configured' });
              }
            });
          });
          req.on('error', () => {
            resolve({ success: true, message: 'CORS headers (error ignored)' });
          });
          req.setTimeout(15000, () => { req.destroy(); resolve({ success: true, message: 'CORS headers (timeout)' }); });
          req.write(putData);
          req.end();
        });
      } else {
        // Create new ruleset
        return new Promise((resolve, reject) => {
          const createData = JSON.stringify({
            name: 'R2 CORS Headers',
            kind: 'zone',
            phase: rulesetPhase,
            rules
          });
          const req = https.request({
            hostname: 'api.cloudflare.com',
            path: `/client/v4/zones/${zoneId}/rulesets`,
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiToken}`,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(createData)
            },
            timeout: 15000
          }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                if (json.success) {
                  resolve({ success: true, message: 'CORS headers configured' });
                } else {
                  resolve({ success: true, message: 'CORS headers (may already be configured)' });
                }
              } catch (e) {
                resolve({ success: true, message: 'CORS headers configured' });
              }
            });
          });
          req.on('error', () => {
            resolve({ success: true, message: 'CORS headers (error ignored)' });
          });
          req.setTimeout(15000, () => { req.destroy(); resolve({ success: true, message: 'CORS headers (timeout)' }); });
          req.write(createData);
          req.end();
        });
      }
    } catch (error) {
      return { success: true, message: `CORS headers (${error.message})` };
    }
  },

  async ensureR2BucketPublic(cwd, bucketName, accountId, apiToken) {
    if (!bucketName || !accountId || !apiToken) {
      return { success: false, error: 'Missing required parameters' };
    }

    try {
      const https = require('https');
      
      // Enable public access on R2 bucket
      return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
          public_access: true
        });
        const req = https.request({
          hostname: 'api.cloudflare.com',
          path: `/client/v4/accounts/${accountId}/r2/buckets/${bucketName}/public-access`,
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          },
          timeout: 15000
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.success) {
                resolve({ success: true, message: 'R2 bucket set to public' });
              } else {
                // If already public or error, continue
                resolve({ success: true, message: 'R2 bucket public access configured' });
              }
            } catch (e) {
              resolve({ success: true, message: 'R2 bucket public access configured' });
            }
          });
        });
        req.on('error', () => {
          resolve({ success: true, message: 'R2 bucket public access (may already be configured)' });
        });
        req.setTimeout(15000, () => { req.destroy(); resolve({ success: true, message: 'R2 bucket public access (timeout, may already be configured)' }); });
        req.write(postData);
        req.end();
      });
    } catch (error) {
      return { success: true, message: 'R2 bucket public access (error ignored)' };
    }
  },

  async ensureR2Bucket(cwd, bucketName) {
    try {
      const result = await runCommand('wrangler r2 bucket list', cwd);
      if (!result.stdout.includes(bucketName)) {
        await runCommand(`wrangler r2 bucket create ${bucketName}`, cwd);
        return { exists: false, created: true, publicDevDomain: null };
      }
      
      let publicDevDomain = null;
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
      const apiToken = process.env.CLOUDFLARE_API_TOKEN || '';
      
      if (accountId && apiToken) {
        try {
          const https = require('https');
          const domainInfo = await new Promise((resolve, reject) => {
            const req = https.request({
              hostname: 'api.cloudflare.com',
              path: `/client/v4/accounts/${accountId}/r2/buckets/${bucketName}/domains/managed`,
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': 'application/json'
              },
              timeout: 10000
            }, (res) => {
              let data = '';
              res.on('data', (chunk) => data += chunk);
              res.on('end', () => {
                try {
                  const json = JSON.parse(data);
                  if (json.success && json.result) {
                    resolve(json.result);
                  } else {
                    reject(new Error(json.errors?.[0]?.message || 'Failed to get bucket domain'));
                  }
                } catch (e) {
                  reject(e);
                }
              });
            });
            req.on('error', reject);
            req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
            req.end();
          });
          
          if (domainInfo && domainInfo.enabled && domainInfo.domain) {
            publicDevDomain = domainInfo.domain.startsWith('http') 
              ? domainInfo.domain 
              : `https://${domainInfo.domain}`;
          }
        } catch (e) {
        }
      }
      
      if (!publicDevDomain) {
        try {
          const bucketInfo = await runCommand(`wrangler r2 bucket info ${bucketName}`, cwd);
          if (bucketInfo.stdout) {
            const domainMatch = bucketInfo.stdout.match(/pub-([a-f0-9-]+)\.r2\.dev/i);
            if (domainMatch) {
              publicDevDomain = `https://pub-${domainMatch[1]}.r2.dev`;
            }
          }
        } catch (e) {
        }
      }
      
      return { exists: true, created: false, publicDevDomain };
    } catch (error) {
      if (!error.message.includes('already exists')) throw error;
      return { exists: true, created: false, publicDevDomain: null };
    }
  },

  async ensureKVNamespace(cwd, namespaceName) {
    try {
      const env = { ...process.env };
      const listOutput = execSync('wrangler kv namespace list', { encoding: 'utf8', stdio: 'pipe', timeout: 10000, cwd, throwOnError: false, env: env });
      
      if (listOutput && (listOutput.includes('Authentication error') || listOutput.includes('code: 10000'))) {
        logWarn('API token does not have KV permissions. Skipping KV namespace operations.');
        return { exists: false, created: false, skipped: true, namespaceId: null, previewId: null };
      }
      
      let exists = false;
      let namespaceId = null;
      let created = false;

      // Parse JSON output from wrangler kv namespace list
      if (listOutput) {
        try {
          const namespaces = JSON.parse(listOutput.trim());
          if (Array.isArray(namespaces)) {
            const namespace = namespaces.find(ns => ns.title === namespaceName && !ns.title.includes('_preview'));
            if (namespace && namespace.id) {
              exists = true;
              namespaceId = namespace.id;
            }
          }
        } catch (parseError) {
          // Fallback to text parsing if JSON parse fails
          const lines = listOutput.split('\n');
          for (const line of lines) {
            if (line.includes(namespaceName) && !line.includes('_preview')) {
              const idMatch = line.match(/([a-f0-9]{32})/i);
              if (idMatch) {
                exists = true;
                namespaceId = idMatch[1];
                break;
              }
            }
          }
        }
      }

      if (!exists || !namespaceId) {
        try {
          const createOutput = execSync(`wrangler kv namespace create "${namespaceName}"`, { encoding: 'utf8', stdio: 'pipe', timeout: 10000, cwd, throwOnError: false, env: env });
          // Try JSON parsing first
          let idMatch = null;
          try {
            const createResult = JSON.parse(createOutput.trim());
            if (createResult && createResult.id) {
              idMatch = [null, createResult.id];
            }
          } catch {
            // Fallback to regex if not JSON
            idMatch = createOutput.match(/id[:\s]+([a-f0-9]{32})/i) || createOutput.match(/"id"\s*:\s*"([a-f0-9]{32})"/i);
          }
          
          if (idMatch && idMatch[1]) {
            namespaceId = idMatch[1];
            created = true;
            exists = true;
          } else {
            // Fallback: list namespaces again to find the newly created one
            const listAfterCreate = execSync('wrangler kv namespace list', { encoding: 'utf8', stdio: 'pipe', timeout: 10000, cwd, throwOnError: false, env: env });
            if (listAfterCreate) {
              try {
                const namespaces = JSON.parse(listAfterCreate.trim());
                if (Array.isArray(namespaces)) {
                  const namespace = namespaces.find(ns => ns.title === namespaceName && !ns.title.includes('_preview'));
                  if (namespace && namespace.id) {
                    namespaceId = namespace.id;
                    exists = true;
                    created = true;
                  }
                }
              } catch {
                // Ignore parse errors
              }
            }
          }
        } catch (createError) {
          const errorMsg = createError.message || createError.stderr || createError.stdout || '';
          if (errorMsg.includes('already exists') || errorMsg.includes('duplicate')) {
            // Namespace already exists, find it in the list
            exists = true;
            const listAfterError = execSync('wrangler kv namespace list', { encoding: 'utf8', stdio: 'pipe', timeout: 10000, cwd, throwOnError: false, env: env });
            if (listAfterError) {
              try {
                const namespaces = JSON.parse(listAfterError.trim());
                if (Array.isArray(namespaces)) {
                  const namespace = namespaces.find(ns => ns.title === namespaceName && !ns.title.includes('_preview'));
                  if (namespace && namespace.id) {
                    namespaceId = namespace.id;
                  }
                }
              } catch {
                // Ignore parse errors - namespace exists but ID not found
              }
            }
          } else {
            throw createError;
          }
        }
      }
      
      return { exists, created, skipped: false, namespaceId, previewId: null };
    } catch (error) {
      if (error.message && error.message.includes('Authentication error')) {
        return { exists: false, created: false, skipped: true, namespaceId: null, previewId: null };
      }
      throw error;
    }
  },

  async ensureD1Database(cwd, databaseName) {
    try {
      const env = { ...process.env };
      const output = execSync('wrangler d1 list --json', { encoding: 'utf8', stdio: 'pipe', timeout: 10000, cwd, throwOnError: false, env: env });
      
      if (output && (output.includes('Authentication error') || output.includes('code: 10000'))) {
        logWarn('API token does not have D1 permissions. Skipping D1 database operations.');
        return { exists: false, created: false, schemaApplied: false, skipped: true, databaseId: null };
      }
      
      let exists = false;
      let databaseId = null;
      let created = false;

      try {
        const parsed = JSON.parse(output);
        const databases = Array.isArray(parsed) ? parsed : (parsed.result || parsed);
        const dbList = Array.isArray(databases) ? databases : [];
        const db = dbList.find(d => d.name === databaseName);
        if (db) {
          exists = true;
          databaseId = db.uuid || db.id || null;
        }
      } catch (e) {
        const textOutput = execSync('wrangler d1 list', { encoding: 'utf8', stdio: 'pipe', timeout: 10000, cwd, throwOnError: false, env: env });
        exists = textOutput && textOutput.includes(databaseName);
        if (exists) {
          const lines = textOutput.split('\n');
          for (const line of lines) {
            if (line.includes(databaseName)) {
              const idMatch = line.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
              if (idMatch) {
                databaseId = idMatch[1];
                break;
              }
            }
          }
        }
      }

      if (!exists) {
        let createResult;
        try {
          createResult = await runCommandWithRetry(`wrangler d1 create ${databaseName}`, cwd, 2, 2000);
          if (createResult && createResult.success) {
            const output = createResult.output || createResult.stdout || '';
            const idMatch = output.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
            if (idMatch) {
              databaseId = idMatch[1];
            }
            created = true;
            exists = true;
          }
        } catch (error) {
          const errorMsg = error.message || error.error || '';
          if (errorMsg.includes('Authentication error') || errorMsg.includes('code: 10000')) {
            logWarn('API token does not have D1 permissions. Skipping D1 database creation.');
            return { exists: false, created: false, schemaApplied: false, skipped: true, databaseId: null };
          }
          createResult = { success: false, error: errorMsg };
        }
      }
      
      if (exists && !databaseId) {
        const listOutput = execSync('wrangler d1 list --json', { encoding: 'utf8', stdio: 'pipe', timeout: 10000, cwd, throwOnError: false, env: env });
        try {
          const parsed = JSON.parse(listOutput);
          const databases = Array.isArray(parsed) ? parsed : (parsed.result || parsed);
          const dbList = Array.isArray(databases) ? databases : [];
          const db = dbList.find(d => d.name === databaseName);
          if (db) {
            databaseId = db.uuid || db.id || null;
          }
        } catch (e) {
        }
      }

      const schemaPath = path.join(cwd, 'backend-cloudflare-workers', 'schema.sql');
      let schemaApplied = false;
      if (exists && fs.existsSync(schemaPath)) {
        try {
          // Old migrations removed - now handled by migration files
          // Migration files in migrations/ folder will be executed separately
          
          const schemaFilePath = path.resolve(schemaPath);
          const execResult = await runCommandWithRetry(`wrangler d1 execute ${databaseName} --remote --file="${schemaFilePath}" --yes`, cwd, 2, 2000);
          if (execResult.success) {
            schemaApplied = true;
          }
        } catch (schemaError) {
          const errorMsg = schemaError.message || schemaError.error || '';
          if (errorMsg.includes('already exists') || errorMsg.includes('duplicate')) {
            schemaApplied = true;
          } else if (errorMsg.includes('Authentication error') || errorMsg.includes('code: 10000')) {
            logWarn('API token does not have D1 permissions. Skipping schema application.');
          } else {
            throw schemaError;
          }
        }
      }

      return { exists, created, schemaApplied, databaseId };
    } catch (error) {
      const errorMsg = error.message || error.error || '';
      if (errorMsg.includes('Authentication error') || errorMsg.includes('code: 10000')) {
        logWarn('API token does not have D1 permissions. Skipping D1 database operations.');
        return { exists: false, created: false, schemaApplied: false, skipped: true, databaseId: null };
      }
      if (errorMsg.includes('already exists') || errorMsg.includes('name is already in use')) {
        return { exists: true, created: false, schemaApplied: false, databaseId: null };
      }
      throw error;
    }
  },

  async deploySecrets(secrets, cwd, workerName, expectedWorkerName = null) {
    if (expectedWorkerName !== null && workerName !== expectedWorkerName) {
      throw new Error(`CRITICAL: Worker name mismatch in secrets deployment. Expected '${expectedWorkerName}', got '${workerName}'. ABORTED.`);
    }
    
    if (!secrets || !Object.keys(secrets).length) return { success: true, deployed: 0, total: 0 };

    const keys = Object.keys(secrets);
    const tempFile = path.join(os.tmpdir(), `secrets-${Date.now()}.json`);

    try {
      fs.writeFileSync(tempFile, JSON.stringify(secrets, null, 2));
      const cmd = workerName ? `wrangler secret bulk "${tempFile}" --name ${workerName}` : `wrangler secret bulk "${tempFile}"`;
      const result = await runCommandWithRetry(cmd, cwd, 2, 2000);
      if (result.success) {
        logSuccess(`Deployed ${keys.length} secrets`);
        return { success: true, deployed: keys.length, total: keys.length };
      }
    } catch {
      // Fallback to individual
    } finally {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // ignore
      }
    }

    let successCount = 0;
    const failedSecrets = [];
    const errorDetails = [];
    for (const [key, value] of Object.entries(secrets)) {
      const secretTempFile = path.join(os.tmpdir(), `secret-${key}-${Date.now()}-${Math.random().toString(36).substring(7)}.txt`);
      try {
        fs.writeFileSync(secretTempFile, value, 'utf8');
        const cmd = workerName ? `wrangler secret put ${key} --name ${workerName}` : `wrangler secret put ${key}`;
        try {
          const result = await runCommand(`cat "${secretTempFile}" | ${cmd}`, cwd);
          if (result.success) {
            successCount++;
          } else {
            failedSecrets.push(key);
            const errorMsg = result.error || result.stderr || result.stdout || 'Unknown error';
            errorDetails.push(`${key}: ${errorMsg}`);
          }
        } catch (error) {
          failedSecrets.push(key);
          errorDetails.push(`${key}: ${error.message || error.stderr || error.stdout || 'Unknown error'}`);
        }
      } catch (error) {
        failedSecrets.push(key);
        errorDetails.push(`${key}: ${error.message}`);
      } finally {
        try {
          fs.unlinkSync(secretTempFile);
        } catch {
          // ignore
        }
      }
    }

    if (successCount === 0) {
      let errorMsg = `Failed to deploy secrets. Failed: ${failedSecrets.join(', ')}`;
      if (errorDetails.length > 0) {
        const firstError = errorDetails[0];
        if (firstError.includes('not found') || firstError.includes('does not exist')) {
          errorMsg += `. Worker "${workerName}" may not exist yet. Deploy the worker first, then deploy secrets.`;
        } else if (firstError.includes('Authentication') || firstError.includes('permission')) {
          errorMsg += `. Authentication or permission error. Check your API token.`;
        } else {
          errorMsg += `. First error: ${firstError}`;
        }
      }
      throw new Error(errorMsg);
    }
    if (successCount < keys.length) {
      logWarn(`Only ${successCount}/${keys.length} secrets deployed. Failed: ${failedSecrets.join(', ')}`);
    }

    return { success: true, deployed: successCount, total: keys.length };
  },

  async deployWorker(cwd, workerName, config, skipD1 = false, databaseId = null, promptCacheNamespaceId = null, envName = null, expectedWorkerName = null, expectedAccountId = null) {
    if (expectedWorkerName !== null && config.workerName !== expectedWorkerName) {
      throw new Error(`CRITICAL: Worker name mismatch. Expected '${expectedWorkerName}', got '${config.workerName}'. Deployment ABORTED.`);
    }
    
    if (expectedAccountId !== null && config.cloudflare?.accountId !== expectedAccountId) {
      throw new Error(`CRITICAL: Account ID mismatch. Expected '${expectedAccountId}', got '${config.cloudflare?.accountId}'. Deployment ABORTED.`);
    }
    
    const wranglerConfigFiles = [
      path.join(cwd, 'wrangler.json'),
      path.join(cwd, 'wrangler.jsonc'),
      path.join(cwd, 'wrangler.toml')
    ];

    if (!envName) {
      for (const configFile of wranglerConfigFiles) {
        if (fs.existsSync(configFile)) {
          try {
            fs.unlinkSync(configFile);
          } catch {
          }
        }
      }
    }

    const wranglerConfigsDir = path.join(cwd, '_deploy-cli-cloudflare-gcp', 'wrangler-configs');
    if (!fs.existsSync(wranglerConfigsDir)) {
      fs.mkdirSync(wranglerConfigsDir, { recursive: true });
    }
    
    const wranglerPath = envName 
      ? path.join(wranglerConfigsDir, `wrangler.${envName}.jsonc`)
      : path.join(wranglerConfigsDir, 'wrangler.jsonc');
    const absoluteWranglerPath = path.resolve(wranglerPath);
    let createdConfig = false;

    try {
      if (fs.existsSync(wranglerPath) && expectedWorkerName !== null && expectedAccountId !== null) {
        try {
          const existingConfig = JSON.parse(fs.readFileSync(wranglerPath, 'utf8'));
          if (existingConfig.name !== expectedWorkerName || existingConfig.account_id !== expectedAccountId) {
            throw new Error(`CRITICAL: Existing wrangler config file contains mismatched worker name or account ID. Expected name: '${expectedWorkerName}', account: '${expectedAccountId}'. Got name: '${existingConfig.name}', account: '${existingConfig.account_id}'. Deployment ABORTED.`);
          }
        } catch (parseError) {
          if (parseError.message.includes('CRITICAL')) throw parseError;
        }
      }
      
      const wranglerConfig = generateWranglerConfig(config, skipD1, databaseId, promptCacheNamespaceId, expectedWorkerName, expectedAccountId, cwd);
      fs.writeFileSync(wranglerPath, JSON.stringify(wranglerConfig, null, 2));
      createdConfig = true;

      let result;
      // Always use --config flag when we create a config file
      const deployCmd = `wrangler deploy --config "${absoluteWranglerPath}"`;
      try {
        result = await runCommandWithRetry(deployCmd, cwd, 3, 2000);
      } catch (error) {
        const errorMsg = error.message || error.error || '';
        if (errorMsg.includes('code: 10214')) {
          result = await runCommandWithRetry(deployCmd, cwd, 2, 3000);
        } else if ((errorMsg.includes('Authentication error') || errorMsg.includes('code: 10000')) && !skipD1) {
          logWarn('Worker deployment failed due to D1 permissions. Retrying without D1 binding...');
          const wranglerConfigNoD1 = generateWranglerConfig(config, true, null, null, expectedWorkerName, expectedAccountId, cwd);
          fs.writeFileSync(wranglerPath, JSON.stringify(wranglerConfigNoD1, null, 2));
          result = await runCommandWithRetry(deployCmd, cwd, 2, 3000);
        } else {
          throw error;
        }
      }
      if (!result || !result.success) throw new Error(result?.error || 'Worker deployment failed');

      const workerUrl = getWorkerUrl(cwd, workerName);
      if (!envName) {
        updateWorkerUrlInHtml(cwd, workerUrl, config);
      }
      return workerUrl;
    } finally {
      if (createdConfig && !envName && fs.existsSync(wranglerPath)) {
        try {
          fs.unlinkSync(wranglerPath);
        } catch {
          // ignore
        }
      }
    }
  },

  async deployPages(cwd, pagesProjectName, sourceDir = null, expectedPagesProjectName = null) {
    if (expectedPagesProjectName !== null && pagesProjectName !== expectedPagesProjectName) {
      throw new Error(`CRITICAL: Pages project name mismatch. Expected '${expectedPagesProjectName}', got '${pagesProjectName}'. Deployment ABORTED.`);
    }
    
    const publicDir = sourceDir || path.join(cwd, 'frontend-cloudflare-pages');
    if (!fs.existsSync(publicDir)) return `https://${pagesProjectName}.pages.dev/`;

    try {
      await runCommandWithRetry(`wrangler pages project create ${pagesProjectName} --production-branch=main`, cwd, 2, 1000);
    } catch {
      // Project might already exist, continue
    }

    try {
      const absDir = path.resolve(publicDir);
      await runCommandWithRetry(`wrangler pages deploy "${absDir}" --project-name=${pagesProjectName} --branch=main --commit-dirty=true`, cwd, 3, 2000);
    } catch {
      // Deployment might have issues but continue
    }

    return `https://${pagesProjectName}.pages.dev/`;
  }
};

async function deploySingleEnvironmentAsChild(envName, cwd, flags = {}) {
  let tempFrontendDir = null;
  
  const cleanup = () => {
    if (tempFrontendDir) {
      cleanupTempFrontendCopy(tempFrontendDir);
    }
  };
  
  // Register cleanup handlers
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(1); });
  process.on('SIGTERM', () => { cleanup(); process.exit(1); });
  process.on('uncaughtException', (err) => { cleanup(); throw err; });
  
  try {
    process.env.DEPLOY_ENV = envName;
    
    const config = await loadConfig();
    config._environment = envName;
    
    validateEnvironmentConfig(config, envName);
    
    if (config._environment !== envName) {
      throw new Error(`CRITICAL: Config environment '${config._environment}' does not match requested '${envName}'. Deployment ABORTED.`);
    }
    
    // Respect deployPages from config, but allow CLI flags to override
    const shouldDeployPages = config.deployPages !== false && flags.DEPLOY_PAGES !== false;
    
    if (shouldDeployPages) {
      tempFrontendDir = createTempFrontendCopy(cwd, envName);
      config._tempFrontendDir = tempFrontendDir;
    }
    
    // Override flags with config setting if present
    const finalFlags = {
      ...flags,
      DEPLOY_PAGES: shouldDeployPages
    };
    
    const result = await deploy(config, null, cwd, finalFlags);
    
    const finalResult = {
      envName,
      success: result.success !== false,
      workerUrl: result.workerUrl || '',
      pagesUrl: result.pagesUrl || '',
      error: result.error || null
    };
    
    console.log(JSON.stringify(finalResult));
    
    // Cleanup before returning
    if (tempFrontendDir) {
      cleanupTempFrontendCopy(tempFrontendDir);
    }
    
    return finalResult;
  } catch (error) {
    const errorResult = {
      envName,
      success: false,
      workerUrl: '',
      pagesUrl: '',
      error: error.message || 'Unknown error'
    };
    console.log(JSON.stringify(errorResult));
    
    // Cleanup on error too
    if (tempFrontendDir) {
      cleanupTempFrontendCopy(tempFrontendDir);
    }
    
    return errorResult;
  } finally {
    // Final cleanup attempt (in case cleanup above failed)
    if (tempFrontendDir && fs.existsSync(tempFrontendDir)) {
      try {
        fs.rmSync(tempFrontendDir, { recursive: true, force: true });
      } catch (e) {
        // Ignore final cleanup errors
      }
    }
  }
}

async function deployMultipleEnvironments(envNames, cwd, flags = {}, args = []) {
  const secretsPath = path.join(cwd, '_deploy-cli-cloudflare-gcp', 'deployments-secrets.json');
  if (!fs.existsSync(secretsPath)) {
    throw new Error('deployments-secrets.json not found');
  }

  let allConfigs;
  try {
    allConfigs = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
  } catch (parseError) {
    const errorMessage = `Invalid JSON in deployments-secrets.json: ${parseError.message}`;
    logCriticalError(errorMessage);
    process.exit(1);
  }
  
  if (!allConfigs.environments) {
    const errorMessage = 'No environments found in deployments-secrets.json';
    logCriticalError(errorMessage);
    throw new Error(errorMessage);
  }

  const envsToDeploy = envNames.length > 0 
    ? envNames.filter(env => allConfigs.environments[env])
    : Object.keys(allConfigs.environments);

  if (envsToDeploy.length === 0) {
    const errorMessage = 'No valid environments to deploy';
    logCriticalError(errorMessage);
    throw new Error(errorMessage);
  }

  // CRITICAL: Validate ALL environments BEFORE starting any deployment
  console.log(`${colors.cyan}Validating all environment configurations before deployment...${colors.reset}\n`);
  const validationErrors = [];
  const originalDeployEnv = process.env.DEPLOY_ENV;
  
  for (const envName of envsToDeploy) {
    try {
      process.env.DEPLOY_ENV = envName;
      const envConfig = allConfigs.environments[envName];
      if (!envConfig) {
        validationErrors.push(`Environment '${envName}': Configuration not found`);
        continue;
      }
      // Create a config object that parseConfig expects (with environments wrapper)
      const configForValidation = { environments: { [envName]: envConfig } };
      // This will throw if validation fails
      parseConfig(configForValidation);
    } catch (error) {
      validationErrors.push(`Environment '${envName}': ${error.message}`);
    }
  }
  
  process.env.DEPLOY_ENV = originalDeployEnv;
  
  if (validationErrors.length > 0) {
    const errorMessage = `Configuration validation failed for ${validationErrors.length} environment(s):\n  - ${validationErrors.join('\n  - ')}\n\nDEPLOYMENT ABORTED - Please fix all configuration errors before deploying.`;
    logCriticalError(errorMessage);
    process.exit(1);
  }
  
  console.log(`${colors.green}✓ All environment configurations validated successfully${colors.reset}\n`);
  console.log(`${colors.cyan}Deploying ${envsToDeploy.length} environment(s) in parallel: ${envsToDeploy.join(', ')}${colors.reset}\n`);

  // Initialize matrix logger for parallel deployments - ONE shared logger
  logger = new DeploymentLogger(envsToDeploy);
  
  // Pre-add all steps that will be used across all environments
  const DEPLOY_SECRETS = flags.DEPLOY_SECRETS !== false;
  const DEPLOY_DB = flags.DEPLOY_DB !== false;
  const DEPLOY_WORKER = flags.DEPLOY_WORKER !== false;
  const DEPLOY_PAGES = flags.DEPLOY_PAGES !== false;
  const DEPLOY_R2 = flags.DEPLOY_R2 !== false;
  const needsCloudflare = DEPLOY_SECRETS || DEPLOY_WORKER || DEPLOY_PAGES || DEPLOY_R2 || DEPLOY_DB;
  const needsGCP = DEPLOY_SECRETS || DEPLOY_WORKER;

  if (needsCloudflare || needsGCP) {
    logger.addStep('Checking prerequisites', 'Validating required tools');
  }
  if (needsGCP) {
    logger.addStep('Authenticating with GCP', 'Connecting to Google Cloud');
    logger.addStep('Checking GCP APIs', 'Verifying Vertex AI and Vision APIs');
  }
  if (needsCloudflare) {
    logger.addStep('Setting up Cloudflare credentials', 'Configuring Cloudflare access');
    if (DEPLOY_R2) {
      logger.addStep('[Cloudflare] R2 Bucket', 'Checking/creating R2 storage bucket');
    }
    if (DEPLOY_DB) {
      logger.addStep('[Cloudflare] D1 Database', 'Checking/creating D1 database');
      logger.addStep('Running database migrations', 'Executing pending migrations');
    }
    logger.addStep('[Cloudflare] KV Namespace', 'Checking/creating KV namespace');
    if (DEPLOY_SECRETS) {
      logger.addStep('Deploying secrets', 'Configuring environment secrets');
    }
    if (DEPLOY_WORKER) {
      logger.addStep('Deploying worker', 'Deploying Cloudflare Worker');
    }
    if (DEPLOY_PAGES) {
      logger.addStep('Deploying frontend', 'Deploying Cloudflare Pages');
    }
  }
  logger.render();

  const deployments = envsToDeploy.map((envName) => {
    return new Promise((resolve) => {
      const scriptPath = __filename;
      const childArgs = [scriptPath, '--child-deploy', envName];
      if (flags.DEPLOY_SECRETS === false) childArgs.push('--no-secrets');
      if (flags.DEPLOY_DB === false) childArgs.push('--no-db');
      if (flags.DEPLOY_WORKER === false) childArgs.push('--no-worker');
      if (flags.DEPLOY_PAGES === false) childArgs.push('--no-pages');
      if (flags.DEPLOY_R2 === false) childArgs.push('--no-r2');
      if (args.includes('--workers-only')) childArgs.push('--workers-only');
      
      const child = spawn('node', childArgs, {
        cwd: cwd,
        env: { ...process.env, __CHILD_DEPLOY__: '1' },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      let jsonOutput = '';

      child.stdout.on('data', (data) => {
        const output = data.toString();
        stdout += output;
        const lines = output.split('\n');
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine.startsWith('{') && trimmedLine.includes('"envName"')) {
            jsonOutput = trimmedLine;
          } else if (trimmedLine.startsWith('__PROGRESS__')) {
            // Parse progress updates from child: __PROGRESS__|stepName|status|message
            try {
              const parts = trimmedLine.split('|');
              if (parts.length >= 4 && logger) {
                const stepName = parts[1];
                const status = parts[2];
                const message = parts.slice(3).join('|');
                const stepIndex = logger.findStep(stepName);
                if (stepIndex >= 0) {
                  if (status === 'running') {
                    logger.startStep(stepIndex, message, envName);
                  } else if (status === 'completed') {
                    logger.completeStep(stepIndex, message, envName);
                  } else if (status === 'failed') {
                    logger.failStep(stepIndex, message, envName);
                  } else if (status === 'warning') {
                    logger.warnStep(stepIndex, message, envName);
                  }
                  // Force render after update
                  logger.render();
                }
              }
            } catch (e) {
              // Ignore parse errors silently
            }
          }
          // Suppress all other child process output - we show it in the matrix instead
        }
      });

      child.stderr.on('data', (data) => {
        const output = data.toString();
        stderr += output;
        process.stderr.write(`[${envName}] ${output}`);
      });

      child.on('close', (code) => {
        // Cleanup temp directory as fallback (in case child process didn't clean up)
        const tempDir = path.join(cwd, `frontend-cloudflare-pages.${envName}.tmp`);
        if (fs.existsSync(tempDir)) {
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch (e) {
            // Ignore cleanup errors
          }
        }
        
        let result;
        try {
          if (jsonOutput) {
            result = JSON.parse(jsonOutput);
          } else {
            const jsonMatch = stdout.match(/\{[\s\S]*"envName"[\s\S]*\}/);
            if (jsonMatch) {
              result = JSON.parse(jsonMatch[0]);
            } else {
              result = {
                envName,
                success: code === 0,
                workerUrl: '',
                pagesUrl: '',
                error: code !== 0 ? (stderr || stdout || 'Unknown error') : null
              };
            }
          }
        } catch (e) {
          result = {
            envName,
            success: code === 0,
            workerUrl: '',
            pagesUrl: '',
            error: code !== 0 ? (stderr || stdout || 'Unknown error') : null
          };
        }
        resolve(result);
      });

      child.on('error', (error) => {
        resolve({
          envName,
          success: false,
          workerUrl: '',
          pagesUrl: '',
          error: error.message
        });
      });
    });
  });

  const results = await Promise.all(deployments);
  
  const deploymentTime = new Date();
  const vietnameseTime = formatVietnameseDateTime(deploymentTime);
  
  console.log('\n' + '='.repeat(80));
  console.log(`${colors.bright}Parallel Deployment Summary${colors.reset}\n`);
  console.log(`${colors.dim}Thời gian triển khai: ${colors.reset}${colors.cyan}${vietnameseTime}${colors.reset}\n`);
  
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  successful.forEach(({ envName, workerUrl, pagesUrl }) => {
    console.log(`${colors.green}✓ ${envName}${colors.reset}`);
    if (workerUrl) console.log(`  Backend: ${workerUrl}`);
    if (pagesUrl) console.log(`  Frontend: ${pagesUrl}`);
  });
  
  if (failed.length > 0) {
    console.log('\n' + colors.red + 'Failed:' + colors.reset);
    failed.forEach(({ envName, error }) => {
      console.log(`${colors.red}✗ ${envName}: ${error || 'Unknown error'}${colors.reset}`);
    });
  }
  
  console.log(`\n${colors.bright}Total: ${successful.length}/${results.length} successful${colors.reset}\n`);
  
  return {
    success: failed.length === 0,
    results: results.reduce((acc, { envName, ...result }) => {
      acc[envName] = result;
      return acc;
    }, {})
  };
}

async function deploy(config, progressCallback, cwd, flags = {}) {
  if (config._environment) {
    validateEnvironmentConfig(config, config._environment);
  }
  
  const useLogger = !progressCallback && !process.env.__CHILD_DEPLOY__;
  if (useLogger) {
    const envName = config._environment ? [config._environment] : [];
    logger = new DeploymentLogger(envName);
    
    const DEPLOY_SECRETS = flags.DEPLOY_SECRETS !== false;
    const DEPLOY_DB = flags.DEPLOY_DB !== false;
    const DEPLOY_WORKER = flags.DEPLOY_WORKER !== false;
    // Respect config.deployPages if set, otherwise use flag
    const DEPLOY_PAGES = config.deployPages !== undefined 
      ? (config.deployPages !== false && flags.DEPLOY_PAGES !== false)
      : flags.DEPLOY_PAGES !== false;
    const DEPLOY_R2 = flags.DEPLOY_R2 !== false;
    const needsCloudflare = DEPLOY_SECRETS || DEPLOY_WORKER || DEPLOY_PAGES || DEPLOY_R2 || DEPLOY_DB;
    const needsGCP = DEPLOY_SECRETS || DEPLOY_WORKER;

    if (needsCloudflare || needsGCP) {
      logger.addStep('Checking prerequisites', 'Validating required tools');
    }
    if (needsGCP) {
      logger.addStep('Authenticating with GCP', 'Connecting to Google Cloud');
      logger.addStep('Checking GCP APIs', 'Verifying Vertex AI and Vision APIs');
    }
    if (needsCloudflare) {
      logger.addStep('Setting up Cloudflare credentials', 'Configuring Cloudflare access');
      if (DEPLOY_R2) {
        logger.addStep(`[Cloudflare] R2 Bucket: ${config.bucketName}`, 'Checking/creating R2 storage bucket');
      }
      if (DEPLOY_DB) {
        logger.addStep(`[Cloudflare] D1 Database: ${config.databaseName}`, 'Checking/creating D1 database');
        logger.addStep('Running database migrations', 'Executing pending migrations');
      }
      logger.addStep(`[Cloudflare] KV Namespace: ${config.promptCacheKV.namespaceName}`, 'Checking/creating KV namespace');
      if (DEPLOY_SECRETS) {
        logger.addStep('Deploying secrets', 'Configuring environment secrets');
      }
      if (DEPLOY_WORKER) {
        logger.addStep('Deploying worker', 'Deploying Cloudflare Worker');
      }
      if (DEPLOY_PAGES) {
        logger.addStep('Deploying frontend', 'Deploying Cloudflare Pages');
      }
    }
    logger.render();
  }

  const report = progressCallback || ((step, status, details, envName = null) => {
    // If this is a child process, ALWAYS send progress to parent first
    if (process.env.__CHILD_DEPLOY__ && config && config._environment) {
      const progressLine = `__PROGRESS__|${step}|${status}|${details || ''}\n`;
      process.stdout.write(progressLine);
    }
    
    // Then update local logger if it exists (for single env deployments)
    if (logger && !process.env.__CHILD_DEPLOY__) {
      const stepIndex = logger.findStep(step);
      if (stepIndex >= 0) {
        if (status === 'running') logger.startStep(stepIndex, details, envName);
        else if (status === 'completed') logger.completeStep(stepIndex, details, envName);
        else if (status === 'failed') logger.failStep(stepIndex, details, envName);
        else if (status === 'warning') logger.warnStep(stepIndex, details, envName);
      }
    }
  });

  const DEPLOY_SECRETS = flags.DEPLOY_SECRETS !== false;
  const DEPLOY_DB = flags.DEPLOY_DB !== false;
  const DEPLOY_WORKER = flags.DEPLOY_WORKER !== false;
  // Respect config.deployPages if set, otherwise use flag
  const DEPLOY_PAGES = config.deployPages !== undefined 
    ? (config.deployPages !== false && flags.DEPLOY_PAGES !== false)
    : flags.DEPLOY_PAGES !== false;
  const DEPLOY_R2 = flags.DEPLOY_R2 !== false;

  const needsCloudflare = DEPLOY_SECRETS || DEPLOY_WORKER || DEPLOY_PAGES || DEPLOY_R2 || DEPLOY_DB;
  const needsGCP = DEPLOY_SECRETS || DEPLOY_WORKER;

  if (needsCloudflare || needsGCP) {
    report('Checking prerequisites', 'running', 'Validating tools');
    if (needsCloudflare && !utils.checkWrangler()) throw new Error('Wrangler CLI not found');
    if (needsGCP && !utils.checkGcloud()) throw new Error('gcloud CLI not found');
    report('Checking prerequisites', 'completed', 'Tools validated');
  }

  if (needsGCP) {
    report('Authenticating with GCP', 'running', 'Connecting to Google Cloud');
    if (!await utils.authenticateGCP(config.gcp)) {
      throw new Error('GCP authentication failed');
    }
    report('Authenticating with GCP', 'completed', 'GCP authenticated');

    report('Checking GCP APIs', 'running', 'Verifying Vertex AI and Vision APIs');
    const apiResults = await utils.ensureGCPApis(config.gcp.projectId);
    if (apiResults.failed.length > 0) {
      const failedApis = apiResults.failed.map(f => f.api).join(', ');
      report('Checking GCP APIs', 'warning', `Some APIs failed to enable: ${failedApis}. Please enable manually in GCP Console.`);
    } else if (apiResults.newlyEnabled.length > 0) {
      report('Checking GCP APIs', 'completed', `Enabled ${apiResults.newlyEnabled.length} API(s)`);
    } else {
      report('Checking GCP APIs', 'completed', 'All required APIs are enabled');
    }
  }

  if (needsCloudflare) {
    report('Setting up Cloudflare credentials', 'running', 'Configuring Cloudflare access');
    let cfToken = config.cloudflare.apiToken;
    let cfAccountId = config.cloudflare.accountId;

    if (!cfToken || !cfAccountId || !await validateCloudflareToken(cfToken)) {
      const creds = await setupCloudflare(config._environment, cfAccountId);
      cfToken = creds.apiToken;
      cfAccountId = creds.accountId;
      config.cloudflare.apiToken = cfToken;
      config.cloudflare.accountId = cfAccountId;
    }
    
    if (cfAccountId) {
      const hasBackendDomain = config.BACKEND_DOMAIN && config.BACKEND_DOMAIN.trim() !== '';

      if (!hasBackendDomain && !config.secrets.BACKEND_DOMAIN) {
        try {
          const whoami = execSync('wrangler whoami', { encoding: 'utf8', stdio: 'pipe', timeout: 5000 });
          const match = whoami.match(/([^\s]+)@/);
          if (match) {
            const workerDevUrl = `https://${config.workerName}.${match[1]}.workers.dev`;
            config.secrets.BACKEND_DOMAIN = workerDevUrl;
            config._workerDevUrl = workerDevUrl;
            if (!process.env.__CHILD_DEPLOY__) {
              console.log(`${colors.cyan}ℹ${colors.reset} Using Worker dev domain: ${workerDevUrl}`);
            }
          }
        } catch {
        }
      }
    }
    
    report('Setting up Cloudflare credentials', 'completed', 'Cloudflare ready');

    const origToken = process.env.CLOUDFLARE_API_TOKEN;
    const origAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    process.env.CLOUDFLARE_API_TOKEN = cfToken;
    process.env.CLOUDFLARE_ACCOUNT_ID = cfAccountId;

    try {
      let r2Result = null;
      if (DEPLOY_R2) {
        report(`[Cloudflare] R2 Bucket: ${config.bucketName}`, 'running', 'Checking bucket existence');
        r2Result = await utils.ensureR2Bucket(cwd, config.bucketName);
        if (r2Result.created) {
          report(`[Cloudflare] R2 Bucket: ${config.bucketName}`, 'completed', 'Bucket created successfully');
        } else {
          report(`[Cloudflare] R2 Bucket: ${config.bucketName}`, 'completed', 'Bucket already exists');
        }
        
        // Ensure bucket is public (no CORS restrictions)
        if (cfAccountId && cfToken) {
          await utils.ensureR2BucketPublic(cwd, config.bucketName, cfAccountId, cfToken);
          // Configure CORS policy on R2 bucket
          await utils.configureR2BucketCORS(config.bucketName, cfAccountId, cfToken);
        }
        
        const hasR2Domain = config.R2_DOMAIN && config.R2_DOMAIN.trim() !== '';
        const r2Domain = hasR2Domain ? config.R2_DOMAIN.trim() : (config.secrets.R2_DOMAIN || r2Result.publicDevDomain);
        
        if (!hasR2Domain && !config.secrets.R2_DOMAIN && r2Result.publicDevDomain && r2Result.publicDevDomain.includes('pub-') && r2Result.publicDevDomain.includes('.r2.dev')) {
          config.secrets.R2_DOMAIN = r2Result.publicDevDomain;
        }
        
        // Configure CORS headers for R2 custom domain via Transform Rules
        if (r2Domain && cfAccountId && cfToken && r2Domain.includes('resources.d.shotpix.app')) {
          await utils.configureR2DomainCORS(r2Domain, cfAccountId, cfToken);
        }
      } else {
        r2Result = await utils.ensureR2Bucket(cwd, config.bucketName);
        // Ensure bucket is public (no CORS restrictions)
        if (cfAccountId && cfToken) {
          await utils.ensureR2BucketPublic(cwd, config.bucketName, cfAccountId, cfToken);
        }
        const hasR2Domain = config.R2_DOMAIN && config.R2_DOMAIN.trim() !== '';
        if (!hasR2Domain && !config.secrets.R2_DOMAIN && r2Result.publicDevDomain && r2Result.publicDevDomain.includes('pub-') && r2Result.publicDevDomain.includes('.r2.dev')) {
          config.secrets.R2_DOMAIN = r2Result.publicDevDomain;
        }
      }
      
      let dbResult = null;
      if (DEPLOY_DB) {
        report(`[Cloudflare] D1 Database: ${config.databaseName}`, 'running', 'Checking database existence');
        dbResult = await utils.ensureD1Database(cwd, config.databaseName);
        if (dbResult.skipped) {
          report(`[Cloudflare] D1 Database: ${config.databaseName}`, 'warning', 'Skipped (API token lacks D1 permissions)');
        } else if (dbResult.created) {
          report(`[Cloudflare] D1 Database: ${config.databaseName}`, 'running', 'Database created, applying schema');
          if (dbResult.schemaApplied) {
            report(`[Cloudflare] D1 Database: ${config.databaseName}`, 'completed', 'Database created & schema applied');
          } else {
            report(`[Cloudflare] D1 Database: ${config.databaseName}`, 'completed', 'Database created');
          }
        } else {
          if (dbResult.schemaApplied) {
            report(`[Cloudflare] D1 Database: ${config.databaseName}`, 'completed', 'Database exists, schema verified');
          } else {
            report(`[Cloudflare] D1 Database: ${config.databaseName}`, 'completed', 'Database already exists');
          }
        }
      } else {
        dbResult = await utils.ensureD1Database(cwd, config.databaseName);
      }

      // Ensure KV namespace for prompt caching
      const promptCacheKVName = config.promptCacheKV.namespaceName;
      report(`[Cloudflare] KV Namespace: ${promptCacheKVName}`, 'running', 'Checking namespace existence');
      const promptCacheResult = await utils.ensureKVNamespace(cwd, promptCacheKVName);
      if (promptCacheResult.skipped) {
        report(`[Cloudflare] KV Namespace: ${promptCacheKVName}`, 'warning', 'Skipped (API token lacks KV permissions)');
      } else if (promptCacheResult.created) {
        report(`[Cloudflare] KV Namespace: ${promptCacheKVName}`, 'completed', 'Namespace created successfully');
      } else {
        report(`[Cloudflare] KV Namespace: ${promptCacheKVName}`, 'completed', 'Namespace already exists');
      }

      // Run database migrations after database is set up
      if (dbResult && !dbResult.skipped) {
        report('Running database migrations', 'running', 'Executing pending migrations');
        try {
          const migrationResult = await runMigrations(config, cwd, cfAccountId, cfToken);
          if (migrationResult.success) {
            if (migrationResult.count === 0) {
              report('Running database migrations', 'completed', 'No pending migrations');
            } else {
              const details = migrationResult.executed > 0 && migrationResult.skipped > 0
                ? `${migrationResult.executed} executed, ${migrationResult.skipped} skipped`
                : migrationResult.executed > 0
                ? `${migrationResult.executed} executed`
                : `${migrationResult.skipped} skipped (TS requires manual execution)`;
              report('Running database migrations', 'completed', details);
              
              if (migrationResult.skippedFiles && migrationResult.skippedFiles.length > 0) {
                console.log(`\n${colors.yellow}⚠ TypeScript migrations skipped:${colors.reset}`);
                migrationResult.skippedFiles.forEach(file => {
                  console.log(`  - ${file} (run manually via Worker /migrate endpoint)`);
                });
              }
            }
          } else {
            report('Running database migrations', 'failed', migrationResult.error || 'Migration failed');
            throw new Error(`Migration failed: ${migrationResult.error}`);
          }
        } catch (error) {
          report('Running database migrations', 'failed', error.message);
          throw error;
        }
      } else if (dbResult && dbResult.skipped) {
        report('Running database migrations', 'warning', 'Skipped (database setup skipped)');
      }

      let workerUrl = '';
      if (DEPLOY_WORKER) {
        report('Deploying worker', 'running', 'Deploying Cloudflare Worker');
        if (!dbResult) {
          dbResult = await utils.ensureD1Database(cwd, config.databaseName);
        }
        const skipD1 = dbResult.skipped || false;
        const databaseId = dbResult.databaseId || null;
        const promptCacheNamespaceId = promptCacheResult?.namespaceId || null;
        const envName = config._environment || null;
        workerUrl = await utils.deployWorker(cwd, config.workerName, config, skipD1, databaseId, promptCacheNamespaceId, envName, config.workerName, config.cloudflare?.accountId);
        
        if (!workerUrl) {
          workerUrl = config._workerDevUrl || getWorkerUrl(cwd, config.workerName);
        }
        
        if (config.BACKEND_DOMAIN && config.BACKEND_DOMAIN.trim() !== '') {
          const domain = config.BACKEND_DOMAIN.trim();
          workerUrl = domain.startsWith('http') ? domain : `https://${domain}`;
        }
        
        report('Deploying worker', 'completed', 'Worker deployed');
      }

      if (DEPLOY_SECRETS) {
        report('Deploying secrets', 'running', 'Configuring environment secrets');
        try {
          if (Object.keys(config.secrets || {}).length > 0) {
            await utils.deploySecrets(config.secrets, cwd, config.workerName, config.workerName);
            report('Deploying secrets', 'completed', 'Secrets deployed');
          } else {
            const existing = utils.getExistingSecrets();
            const { missing, allSet } = checkSecrets(existing);
            if (!allSet) {
              report('Deploying secrets', 'warning', `Missing secrets: ${missing.join(', ')}`);
            } else {
              report('Deploying secrets', 'completed', 'All secrets set');
            }
          }
        } catch (error) {
          report('Deploying secrets', 'failed', error.message);
          throw error;
        }
      }

      let pagesUrl = '';
      let tempFrontendDir = null;
      let shouldCleanupTemp = false;
      if (DEPLOY_PAGES) {
        report('Deploying frontend', 'running', 'Deploying Cloudflare Pages');
        
        // Create temp folder copy if not already created (to avoid editing source file directly)
        if (!config._tempFrontendDir) {
          const envName = config._environment || 'default';
          tempFrontendDir = createTempFrontendCopy(cwd, envName);
          config._tempFrontendDir = tempFrontendDir;
          shouldCleanupTemp = true;
          
          // Build docs in temp directory to ensure latest generated HTML is included
          const docsBuildScript = path.join(tempFrontendDir, 'docs', 'build-static.js');
          const docsIndexPath = path.join(tempFrontendDir, 'docs', 'index.html');
          if (fs.existsSync(docsBuildScript)) {
            try {
              report('Building docs', 'running', 'Generating static documentation');
              execSync(`node "${docsBuildScript}"`, { cwd: tempFrontendDir, stdio: 'inherit' });
              // Verify docs were built
              if (fs.existsSync(docsIndexPath)) {
                const stat = fs.statSync(docsIndexPath);
                report('Building docs', 'completed', `Documentation built (${Math.round(stat.size / 1024)}KB)`);
                console.log(`${colors.green}✓ Docs built successfully: ${docsIndexPath}${colors.reset}`);
              } else {
                throw new Error('Docs build completed but index.html not found');
              }
            } catch (error) {
              console.error(`${colors.red}Error building docs: ${error.message}${colors.reset}`);
              console.warn(`${colors.yellow}Warning: Continuing deployment without updated docs${colors.reset}`);
              report('Building docs', 'failed', `Documentation build failed: ${error.message}`);
            }
          } else {
            console.warn(`${colors.yellow}Warning: Docs build script not found at ${docsBuildScript}${colors.reset}`);
          }
        } else {
          tempFrontendDir = config._tempFrontendDir;
        }
        
        // Update HTML with correct backend URL before deploying Pages
        const backendUrl = config.BACKEND_DOMAIN 
          ? (config.BACKEND_DOMAIN.startsWith('http') ? config.BACKEND_DOMAIN : `https://${config.BACKEND_DOMAIN}`)
          : (workerUrl || config._workerDevUrl || `https://${config.workerName}.workers.dev`);
        const htmlPath = path.join(tempFrontendDir, 'index.html');
        const sourceDir = tempFrontendDir;
        updateWorkerUrlInHtml(cwd, backendUrl, config, htmlPath);
        
        // Verify docs folder exists before deploying
        const docsFolder = path.join(tempFrontendDir, 'docs');
        const docsIndex = path.join(docsFolder, 'index.html');
        if (fs.existsSync(docsFolder)) {
          if (fs.existsSync(docsIndex)) {
            const stat = fs.statSync(docsIndex);
            console.log(`${colors.green}✓ Docs folder ready for deployment (${Math.round(stat.size / 1024)}KB)${colors.reset}`);
          } else {
            console.warn(`${colors.yellow}⚠ Docs folder exists but index.html is missing${colors.reset}`);
          }
        } else {
          console.warn(`${colors.yellow}⚠ Docs folder not found in deployment directory${colors.reset}`);
        }
        
        pagesUrl = await utils.deployPages(cwd, config.pagesProjectName, sourceDir, config.pagesProjectName);
        report('Deploying frontend', 'completed', 'Frontend deployed');
        
        // Cleanup temp folder only if we created it (caller handles cleanup if it created the temp folder)
        if (shouldCleanupTemp && tempFrontendDir) {
          cleanupTempFrontendCopy(tempFrontendDir);
        }
      }

      if (useLogger && logger) {
        logger.renderSummary({ workerUrl, pagesUrl });
      } else {
        console.log('\n' + '='.repeat(50));
        console.log('✓ Deployment Complete!');
        console.log('\n📌 URLs:');
        if (workerUrl) console.log(`   ✅ Backend: ${workerUrl}`);
        if (pagesUrl) console.log(`   ✅ Frontend: ${pagesUrl}`);
        if (!workerUrl && !pagesUrl) console.log(`   ✅ Frontend: https://${config.pagesProjectName}.pages.dev/`);
        console.log('');
      }

      return { success: true, workerUrl, pagesUrl };
    } finally {
      restoreEnv(origToken, origAccountId);
    }
  } else {
    return { success: true, message: 'No deployment steps selected' };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const migrateOnly = args.includes('--migrate-only') || args.includes('--db-migrate');
  const childDeployIndex = args.findIndex(arg => arg === '--child-deploy');
  const envsIndex = args.findIndex(arg => arg === '--envs' || arg === '--environments');
  const allEnvs = args.includes('--all-envs');
  
  if (childDeployIndex >= 0 && args[childDeployIndex + 1]) {
    const envName = args[childDeployIndex + 1];
    const workersOnly = args.includes('--workers-only');
    const flags = {
      DEPLOY_SECRETS: workersOnly ? false : !args.includes('--no-secrets'),
      DEPLOY_DB: workersOnly ? false : !args.includes('--no-db'),
      DEPLOY_WORKER: !args.includes('--no-worker'),
      DEPLOY_PAGES: workersOnly ? false : !args.includes('--no-pages'),
      DEPLOY_R2: workersOnly ? false : !args.includes('--no-r2')
    };
    
    try {
      const result = await deploySingleEnvironmentAsChild(envName, process.cwd(), flags);
      process.exit(result.success ? 0 : 1);
    } catch (error) {
      const errorResult = {
        envName,
        success: false,
        workerUrl: '',
        pagesUrl: '',
        error: error.message || 'Unknown error'
      };
      console.log(JSON.stringify(errorResult));
      process.exit(1);
    }
    return;
  }
  
  if (envsIndex >= 0 || allEnvs) {
    const secretsPath = path.join(process.cwd(), '_deploy-cli-cloudflare-gcp', 'deployments-secrets.json');
    if (!fs.existsSync(secretsPath)) {
      console.error('deployments-secrets.json not found');
      process.exit(1);
    }
    
    const allConfigs = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
    const envsToDeploy = allEnvs 
      ? Object.keys(allConfigs.environments || {})
      : (envsIndex >= 0 && args[envsIndex + 1] 
          ? args[envsIndex + 1].split(',').map(e => e.trim())
          : []);
    
    if (envsToDeploy.length === 0) {
      console.error('No environments specified or found');
      process.exit(1);
    }
    
    const workersOnly = args.includes('--workers-only');
    const flags = {
      DEPLOY_SECRETS: workersOnly ? false : !args.includes('--no-secrets'),
      DEPLOY_DB: workersOnly ? false : !args.includes('--no-db'),
      DEPLOY_WORKER: !args.includes('--no-worker'),
      DEPLOY_PAGES: workersOnly ? false : !args.includes('--no-pages'),
      DEPLOY_R2: workersOnly ? false : !args.includes('--no-r2')
    };
    
    try {
      const result = await deployMultipleEnvironments(envsToDeploy, process.cwd(), flags, args);
      
      // Run tests after successful deployment (skip if --skip-tests flag is set or if already in test mode)
      if (result.success && !args.includes('--skip-tests') && !process.env.SKIP_POST_DEPLOY_TESTS) {
        console.log(`\n${colors.cyan}${colors.bright}Running post-deployment tests...${colors.reset}\n`);
        try {
          // Set flag to prevent recursion
          process.env.SKIP_POST_DEPLOY_TESTS = '1';
          execSync('npm run deploy:parallel:test', { 
            stdio: 'inherit',
            cwd: process.cwd(),
            env: { ...process.env, SKIP_POST_DEPLOY_TESTS: '1' }
          });
          console.log(`\n${colors.green}${colors.bright}✓ Post-deployment tests completed successfully${colors.reset}\n`);
        } catch (testError) {
          console.error(`\n${colors.yellow}⚠ Post-deployment tests failed, but deployment was successful${colors.reset}`);
          console.error(`${colors.red}Test error: ${testError.message}${colors.reset}\n`);
          // Don't fail deployment if tests fail
        } finally {
          delete process.env.SKIP_POST_DEPLOY_TESTS;
        }
      }
      
      process.exit(result.success ? 0 : 1);
    } catch (error) {
      console.error(`${colors.red}Parallel deployment failed: ${error.message}${colors.reset}`);
      process.exit(1);
    }
    return;
  }
  
  logger = new DeploymentLogger();
  
  if (migrateOnly) {
    logger.addStep('Checking prerequisites', 'Validating required tools');
    logger.addStep('Loading configuration', 'Reading deployment configuration');
    logger.addStep('Setting up Cloudflare credentials', 'Configuring Cloudflare access');
    logger.addStep(`[Cloudflare] D1 Database Migration`, 'Applying database migration');
    logger.render();

    try {
      logger.startStep('Checking prerequisites');
      if (!utils.checkWrangler()) {
        logger.failStep('Checking prerequisites', 'Wrangler CLI not found');
        process.exit(1);
      }
      logger.completeStep('Checking prerequisites', 'Tools validated');

      logger.startStep('Loading configuration');
      const config = await loadConfig();
      logger.completeStep('Loading configuration', 'Configuration loaded');

      logger.startStep('Setting up Cloudflare credentials');
      let cfToken = config.cloudflare.apiToken;
      let cfAccountId = config.cloudflare.accountId;

      if (!cfToken || !cfAccountId || !await validateCloudflareToken(cfToken)) {
        const creds = await setupCloudflare(config._environment, cfAccountId);
        cfToken = creds.apiToken;
        cfAccountId = creds.accountId;
        config.cloudflare.apiToken = cfToken;
        config.cloudflare.accountId = cfAccountId;
      }
      
      process.env.CLOUDFLARE_ACCOUNT_ID = cfAccountId;
      logger.completeStep('Setting up Cloudflare credentials', 'Cloudflare ready');

      const origToken = process.env.CLOUDFLARE_API_TOKEN;
      const origAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      process.env.CLOUDFLARE_API_TOKEN = cfToken;
      process.env.CLOUDFLARE_ACCOUNT_ID = cfAccountId;

      try {
        logger.startStep(`[Cloudflare] D1 Database Migration`);
        const migrationResult = await runMigrations(config, process.cwd(), cfAccountId, cfToken);
        
        if (migrationResult.success) {
          if (migrationResult.count === 0) {
            logger.completeStep(`[Cloudflare] D1 Database Migration`, 'No pending migrations found');
          } else {
            const details = migrationResult.executed > 0 && migrationResult.skipped > 0
              ? `${migrationResult.executed} executed, ${migrationResult.skipped} skipped`
              : migrationResult.executed > 0
              ? `${migrationResult.executed} executed`
              : `${migrationResult.skipped} skipped (TS requires manual execution)`;
            logger.completeStep(`[Cloudflare] D1 Database Migration`, details);
            
            if (migrationResult.skippedFiles && migrationResult.skippedFiles.length > 0) {
              console.log(`\n${colors.yellow}⚠ TypeScript migrations skipped:${colors.reset}`);
              migrationResult.skippedFiles.forEach(file => {
                console.log(`  - ${file} (run manually via Worker /migrate endpoint)`);
              });
            }
          }
        } else {
          logger.failStep(`[Cloudflare] D1 Database Migration`, migrationResult.error || 'Migration failed');
          throw new Error(`Migration failed: ${migrationResult.error}`);
        }
        
        logger.renderSummary({ workerUrl: '', pagesUrl: '' });
      } finally {
        restoreEnv(origToken, origAccountId);
      }
    } catch (error) {
      if (logger && logger.currentStepIndex >= 0) {
        logger.failStep(logger.currentStepIndex, error.message);
      }
      if (logger) logger.renderSummary();
      process.exit(1);
    }
    return;
  }
  
  logger.addStep('Loading configuration', 'Reading deployment configuration');
  logger.render();

  try {
    logger.startStep('Loading configuration');
    const config = await loadConfig();
    
    // Parse flags for single environment deployment
    const workersOnly = args.includes('--workers-only');
    if (workersOnly) {
      config.deployPages = false;
    }
    
    logger.completeStep('Loading configuration', 'Configuration loaded');

    // Only add steps that are needed
    if (!workersOnly) {
      logger.addStep('Checking prerequisites', 'Validating required tools');
      logger.addStep('Authenticating with GCP', 'Connecting to Google Cloud');
      logger.addStep('Checking GCP APIs', 'Verifying Vertex AI and Vision APIs');
      logger.addStep('Setting up Cloudflare credentials', 'Configuring Cloudflare access');
      logger.addStep(`[Cloudflare] R2 Bucket: ${config.bucketName}`, 'Checking/creating R2 storage bucket');
      logger.addStep(`[Cloudflare] D1 Database: ${config.databaseName}`, 'Checking/creating D1 database');
      logger.addStep('Deploying secrets', 'Configuring environment secrets');
    } else {
      logger.addStep('Checking prerequisites', 'Validating required tools');
      logger.addStep('Setting up Cloudflare credentials', 'Configuring Cloudflare access');
    }
    logger.addStep('Deploying worker', 'Deploying Cloudflare Worker');
    if (!workersOnly && config.deployPages) {
      logger.addStep('Deploying frontend', 'Deploying Cloudflare Pages');
    }
    logger.render();

    logger.startStep('Checking prerequisites');
    if (!utils.checkWrangler()) {
      logger.failStep('Checking prerequisites', 'Wrangler CLI not found');
      process.exit(1);
    }
    if (!workersOnly && !utils.checkGcloud()) {
      logger.failStep('Checking prerequisites', 'gcloud CLI not found');
      process.exit(1);
    }
    logger.completeStep('Checking prerequisites', 'Tools validated');

    if (!workersOnly) {
      logger.startStep('Authenticating with GCP');
      if (!await utils.authenticateGCP(config.gcp)) {
        logger.failStep('Authenticating with GCP', 'GCP authentication failed');
        process.exit(1);
      }
      logger.completeStep('Authenticating with GCP', 'GCP authenticated');

      logger.startStep('Checking GCP APIs');
      const apiResults = await utils.ensureGCPApis(config.gcp.projectId);
      if (apiResults.failed.length > 0) {
        const failedApis = apiResults.failed.map(f => f.api).join(', ');
        logger.warnStep('Checking GCP APIs', `Some APIs failed: ${failedApis}`);
      } else if (apiResults.newlyEnabled.length > 0) {
        logger.completeStep('Checking GCP APIs', `Enabled ${apiResults.newlyEnabled.length} API(s)`);
      } else {
        logger.completeStep('Checking GCP APIs', 'All required APIs are enabled');
      }
    }

    logger.startStep('Setting up Cloudflare credentials');
    let cfToken = config.cloudflare.apiToken;
    let cfAccountId = config.cloudflare.accountId;

    if (!cfToken || !cfAccountId || !await validateCloudflareToken(cfToken)) {
      const creds = await setupCloudflare(config._environment, cfAccountId);
      cfToken = creds.apiToken;
      cfAccountId = creds.accountId;
      config.cloudflare.apiToken = cfToken;
      config.cloudflare.accountId = cfAccountId;
    }
    
    if (cfAccountId) {
      const hasBackendDomain = config.BACKEND_DOMAIN && config.BACKEND_DOMAIN.trim() !== '';

      if (!hasBackendDomain && !config.secrets.BACKEND_DOMAIN) {
        try {
          const whoami = execSync('wrangler whoami', { encoding: 'utf8', stdio: 'pipe', timeout: 5000 });
          const match = whoami.match(/([^\s]+)@/);
          if (match) {
            const workerDevUrl = `https://${config.workerName}.${match[1]}.workers.dev`;
            config.secrets.BACKEND_DOMAIN = workerDevUrl;
            config._workerDevUrl = workerDevUrl;
            if (!process.env.__CHILD_DEPLOY__) {
              console.log(`${colors.cyan}ℹ${colors.reset} Using Worker dev domain: ${workerDevUrl}`);
            }
          }
        } catch {
        }
      }
    }
    
    process.env.CLOUDFLARE_ACCOUNT_ID = cfAccountId;
    logger.completeStep('Setting up Cloudflare credentials', 'Cloudflare ready');

    const origToken = process.env.CLOUDFLARE_API_TOKEN;
    const origAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    process.env.CLOUDFLARE_API_TOKEN = cfToken;
    process.env.CLOUDFLARE_ACCOUNT_ID = cfAccountId;

    try {
      let dbResult = { skipped: false, databaseId: null };
      let promptCacheResult = { namespaceId: null };
      
      if (!workersOnly) {
        logger.startStep(`[Cloudflare] R2 Bucket: ${config.bucketName}`);
        const r2Result = await utils.ensureR2Bucket(process.cwd(), config.bucketName);
        if (r2Result.created) {
          logger.completeStep(`[Cloudflare] R2 Bucket: ${config.bucketName}`, 'Bucket created successfully');
        } else {
          logger.completeStep(`[Cloudflare] R2 Bucket: ${config.bucketName}`, 'Bucket already exists');
        }
        
        // Ensure bucket is public (no CORS restrictions)
        if (cfAccountId && cfToken) {
          await utils.ensureR2BucketPublic(process.cwd(), config.bucketName, cfAccountId, cfToken);
          // Configure CORS policy on R2 bucket
          await utils.configureR2BucketCORS(config.bucketName, cfAccountId, cfToken);
        }
        
        const hasR2Domain = config.R2_DOMAIN && config.R2_DOMAIN.trim() !== '';
        const r2Domain = hasR2Domain ? config.R2_DOMAIN.trim() : (config.secrets.R2_DOMAIN || r2Result.publicDevDomain);
        
        if (!hasR2Domain && !config.secrets.R2_DOMAIN && r2Result.publicDevDomain && r2Result.publicDevDomain.includes('pub-') && r2Result.publicDevDomain.includes('.r2.dev')) {
          config.secrets.R2_DOMAIN = r2Result.publicDevDomain;
        }
        
        // Configure CORS headers for R2 custom domain via Transform Rules
        if (r2Domain && cfAccountId && cfToken && r2Domain.includes('resources.d.shotpix.app')) {
          await utils.configureR2DomainCORS(r2Domain, cfAccountId, cfToken);
        }

        logger.startStep(`[Cloudflare] D1 Database: ${config.databaseName}`);
        dbResult = await utils.ensureD1Database(process.cwd(), config.databaseName);
        if (dbResult.skipped) {
          logger.warnStep(`[Cloudflare] D1 Database: ${config.databaseName}`, 'Skipped (API token lacks D1 permissions)');
        } else if (dbResult.created) {
          if (dbResult.schemaApplied) {
            logger.completeStep(`[Cloudflare] D1 Database: ${config.databaseName}`, 'Database created & schema applied');
          } else {
            logger.completeStep(`[Cloudflare] D1 Database: ${config.databaseName}`, 'Database created');
          }
        } else {
          if (dbResult.schemaApplied) {
            logger.completeStep(`[Cloudflare] D1 Database: ${config.databaseName}`, 'Database exists, schema verified');
          } else {
            logger.completeStep(`[Cloudflare] D1 Database: ${config.databaseName}`, 'Database already exists');
          }
        }

        const promptCacheKVName = config.promptCacheKV.namespaceName;
        logger.startStep(`[Cloudflare] KV Namespace: ${promptCacheKVName}`);
        promptCacheResult = await utils.ensureKVNamespace(process.cwd(), promptCacheKVName);
        if (promptCacheResult.skipped) {
          logger.warnStep(`[Cloudflare] KV Namespace: ${promptCacheKVName}`, 'Skipped (API token lacks KV permissions)');
        } else if (promptCacheResult.created) {
          logger.completeStep(`[Cloudflare] KV Namespace: ${promptCacheKVName}`, 'Namespace created successfully');
        } else {
          logger.completeStep(`[Cloudflare] KV Namespace: ${promptCacheKVName}`, 'Namespace already exists');
        }

        logger.startStep('Deploying secrets');
        if (Object.keys(config.secrets).length > 0) {
          await utils.deploySecrets(config.secrets, process.cwd(), config.workerName, config.workerName);
          logger.completeStep('Deploying secrets', 'Secrets deployed');
        } else {
          const existing = utils.getExistingSecrets();
          const { missing, allSet } = checkSecrets(existing);
          if (!allSet) {
            logger.warnStep('Deploying secrets', `Missing secrets: ${missing.join(', ')}`);
          } else {
            logger.completeStep('Deploying secrets', 'All secrets set');
          }
        }
      } else {
        // For workers-only, we still need KV namespace for worker bindings
        const promptCacheKVName = config.promptCacheKV.namespaceName;
        logger.startStep(`[Cloudflare] KV Namespace: ${promptCacheKVName}`);
        promptCacheResult = await utils.ensureKVNamespace(process.cwd(), promptCacheKVName);
        if (promptCacheResult.skipped) {
          logger.warnStep(`[Cloudflare] KV Namespace: ${promptCacheKVName}`, 'Skipped (API token lacks KV permissions)');
        } else if (promptCacheResult.created) {
          logger.completeStep(`[Cloudflare] KV Namespace: ${promptCacheKVName}`, 'Namespace created successfully');
        } else {
          logger.completeStep(`[Cloudflare] KV Namespace: ${promptCacheKVName}`, 'Namespace already exists');
        }
      }

      logger.startStep('Deploying worker');
      const skipD1 = dbResult.skipped || false;
      const databaseId = dbResult.databaseId || null;
      
      const promptCacheNamespaceId = promptCacheResult?.namespaceId || null;
      const envName = config._environment || null;

      let workerUrl = await utils.deployWorker(process.cwd(), config.workerName, config, skipD1, databaseId, promptCacheNamespaceId, envName, config.workerName, config.cloudflare?.accountId);
      
      if (!workerUrl) {
        workerUrl = config._workerDevUrl || getWorkerUrl(process.cwd(), config.workerName);
      }
      
      if (config.BACKEND_DOMAIN) {
        workerUrl = config.BACKEND_DOMAIN.startsWith('http') 
          ? config.BACKEND_DOMAIN 
          : `https://${config.BACKEND_DOMAIN}`;
      }
      
      logger.completeStep('Deploying worker', 'Worker deployed');

      if (!workersOnly) {
        logger.startStep('Deploying secrets');
        try {
          if (Object.keys(config.secrets).length > 0) {
            await utils.deploySecrets(config.secrets, process.cwd(), config.workerName, config.workerName);
            logger.completeStep('Deploying secrets', 'Secrets deployed');
          } else {
            const existing = utils.getExistingSecrets();
            const { missing, allSet } = checkSecrets(existing);
            if (!allSet) {
              logger.warnStep('Deploying secrets', `Missing secrets: ${missing.join(', ')}`);
            } else {
              logger.completeStep('Deploying secrets', 'All secrets set');
            }
          }
        } catch (error) {
          logger.failStep('Deploying secrets', error.message);
          throw error;
        }
      }

      let pagesUrl = '';
      let tempFrontendDir = null;
      if (!workersOnly && config.deployPages) {
        logger.startStep('Deploying frontend');
        // Create temp folder copy to avoid editing source file directly
        const envName = config._environment || 'default';
        tempFrontendDir = createTempFrontendCopy(process.cwd(), envName);
        config._tempFrontendDir = tempFrontendDir;
        
        // Build docs in temp directory to ensure latest generated HTML is included
        const docsBuildScript = path.join(tempFrontendDir, 'docs', 'build-static.js');
        const docsIndexPath = path.join(tempFrontendDir, 'docs', 'index.html');
        if (fs.existsSync(docsBuildScript)) {
          try {
            logger.startStep('Building docs');
            execSync(`node "${docsBuildScript}"`, { cwd: tempFrontendDir, stdio: 'inherit' });
            // Verify docs were built
            if (fs.existsSync(docsIndexPath)) {
              const stat = fs.statSync(docsIndexPath);
              logger.completeStep('Building docs', `Documentation built (${Math.round(stat.size / 1024)}KB)`);
              console.log(`${colors.green}✓ Docs built successfully: ${docsIndexPath}${colors.reset}`);
            } else {
              throw new Error('Docs build completed but index.html not found');
            }
          } catch (error) {
            console.error(`${colors.red}Error building docs: ${error.message}${colors.reset}`);
            console.warn(`${colors.yellow}Warning: Continuing deployment without updated docs${colors.reset}`);
            logger.completeStep('Building docs', `Documentation build failed: ${error.message}`);
          }
        } else {
          console.warn(`${colors.yellow}Warning: Docs build script not found at ${docsBuildScript}${colors.reset}`);
        }
        
        // Update HTML with correct backend URL before deploying Pages
        const backendUrl = config.BACKEND_DOMAIN 
          ? (config.BACKEND_DOMAIN.startsWith('http') ? config.BACKEND_DOMAIN : `https://${config.BACKEND_DOMAIN}`)
          : (workerUrl || config._workerDevUrl || `https://${config.workerName}.workers.dev`);
        const htmlPath = path.join(tempFrontendDir, 'index.html');
        const sourceDir = tempFrontendDir;
        updateWorkerUrlInHtml(process.cwd(), backendUrl, config, htmlPath);
        
        // Verify docs folder exists before deploying
        const docsFolder = path.join(tempFrontendDir, 'docs');
        const docsIndex = path.join(docsFolder, 'index.html');
        if (fs.existsSync(docsFolder)) {
          if (fs.existsSync(docsIndex)) {
            const stat = fs.statSync(docsIndex);
            console.log(`${colors.green}✓ Docs folder ready for deployment (${Math.round(stat.size / 1024)}KB)${colors.reset}`);
          } else {
            console.warn(`${colors.yellow}⚠ Docs folder exists but index.html is missing${colors.reset}`);
          }
        } else {
          console.warn(`${colors.yellow}⚠ Docs folder not found in deployment directory${colors.reset}`);
        }
        
        pagesUrl = await utils.deployPages(process.cwd(), config.pagesProjectName, sourceDir, config.pagesProjectName);
        logger.completeStep('Deploying frontend', 'Frontend deployed');
        
        // Cleanup temp folder
        if (tempFrontendDir) {
          cleanupTempFrontendCopy(tempFrontendDir);
        }
      } else {
        logger.skipStep('Deploying frontend', 'Skipped (deployPages disabled)');
      }

      logger.renderSummary({ workerUrl, pagesUrl: pagesUrl || `https://${config.pagesProjectName}.pages.dev/` });

    } finally {
      restoreEnv(origToken, origAccountId);
    }
  } catch (error) {
    if (logger && logger.currentStepIndex >= 0) {
      logger.failStep(logger.currentStepIndex, error.message);
    }
    if (logger) logger.renderSummary();
    process.exit(1);
  }
}

module.exports = {
  deployFromConfig: async (config, progressCallback, cwd, flags = {}) => {
    try {
      if (config.cloudflare?.apiToken) process.env.CLOUDFLARE_API_TOKEN = config.cloudflare.apiToken;
      if (config.cloudflare?.accountId) process.env.CLOUDFLARE_ACCOUNT_ID = config.cloudflare.accountId;
      if (config.deployPages !== undefined) process.env.DEPLOY_PAGES = config.deployPages.toString();

      return await deploy(config, progressCallback, cwd || process.cwd(), flags);
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  },
  loadConfig
};

if (require.main === module) {
  main().catch((error) => {
    logError(`Deployment failed: ${error.message}`);
    process.exit(1);
  });
}
