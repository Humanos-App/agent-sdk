import { runContract } from './contract.js';
import { openrouterGenerate, openrouterStream } from './drivers/openrouter.js';

runContract(openrouterGenerate);
runContract(openrouterStream);
