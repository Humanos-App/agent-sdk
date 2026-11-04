import { runContract } from './contract.js';
import { agent, graph } from './drivers/langchain.js';

runContract(agent);
runContract(graph);
