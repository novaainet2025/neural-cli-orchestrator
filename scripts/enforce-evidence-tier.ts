import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const configPath = resolve('config/ai-providers.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

const targetPattern = '3) EVIDENCE TIERS: ground truth (files/DB/HTTP bodies) > process existence > status strings > another agent\'s natural-language claim. Base conclusions on the highest tier available; label the tier.';
const replacement = '3) EVIDENCE TIERS: ground truth (files/DB/HTTP bodies) > process existence > status strings > another agent\'s natural-language claim. Base conclusions on the highest tier available. You MUST explicitly state the evidence tier used in your \'done:\' verification message (e.g., "[Evidence Tier 1] file/content verified" or "[Evidence Tier 2] process verified").';

let modifiedCount = 0;
for (const provider of config.providers) {
  if (provider.persona && provider.persona.systemPrompt) {
    if (provider.persona.systemPrompt.includes(targetPattern)) {
      provider.persona.systemPrompt = provider.persona.systemPrompt.replace(targetPattern, replacement);
      modifiedCount++;
    }
  }
}

if (modifiedCount > 0) {
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  console.log(`Successfully updated ${modifiedCount} agent system prompts to enforce Evidence Tier rules.`);
} else {
  console.log('No prompts matching the Evidence Tier pattern were found or they are already updated.');
}
