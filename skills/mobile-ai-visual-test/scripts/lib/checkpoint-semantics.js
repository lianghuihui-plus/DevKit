'use strict';

function checkpointRequirements(understanding, checkpoint) {
  const byId = new Map((understanding?.requirements || []).map((requirement) => [requirement.id, requirement]));
  return (checkpoint?.requirementRefs || []).map((ref) => byId.get(ref)).filter(Boolean);
}

function expandCheckpoint(understanding, checkpoint) {
  if (!checkpoint) return null;
  const requirements = checkpointRequirements(understanding, checkpoint);
  const requiredInteractions = requirements.flatMap((requirement) => requirement.requiredInteractions || []);
  const expectedOutcomes = requirements.flatMap((requirement) => requirement.expectedOutcomes || []);
  return {
    id: checkpoint.id,
    objective: checkpoint.objective,
    requirementRefs: [...(checkpoint.requirementRefs || [])],
    requirements: requirements.map((requirement) => ({
      id: requirement.id,
      text: requirement.text,
      basis: requirement.basis,
      requiredInteractions: [...(requirement.requiredInteractions || [])],
      expectedOutcomes: [...(requirement.expectedOutcomes || [])],
    })),
    requiredInteractions,
    expectedOutcomes,
    requiresAction: requiredInteractions.length > 0,
  };
}

module.exports = { checkpointRequirements, expandCheckpoint };
