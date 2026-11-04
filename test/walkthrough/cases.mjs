// What each walkthrough run asks the agent, by case name: one tool call each, as a person would ask in words.
export const CASES = {
  lookup: 'Look up order A-1 with the lookup_order tool, then say in one sentence what it returned.',
  refund: 'Refund 40 euros on order A-1 with the issue_refund tool, then say in one sentence what happened.',
  discount5: 'Approve a 5 percent discount on order A-1 with the approve_discount tool, then say in one sentence what happened.',
  discount15: 'Approve a 15 percent discount on order A-1 with the approve_discount tool, then say in one sentence what happened.',
};
export const SERVICE = 'Support desk (live test)';
