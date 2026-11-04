import { runContract } from './contract.js';
import { generate, stream } from './drivers/ai-sdk.js';

runContract(generate);
runContract(stream);
