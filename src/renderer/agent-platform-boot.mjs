import { mountAgentPlatform } from './agent-platform.mjs';

try {
  mountAgentPlatform();
} catch (err) {
  console.error('[agent-platform] ui unavailable:', err);
}