import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

export type ProjectSkill = {
  name: string;
  description: string;
  path: string;
};

export const agentsSkillsDirectory = (cwd = process.cwd()): string =>
  resolve(cwd, ".agents", "skills");

/**
 * Keeps the slash-command list aligned with the same Agent Skills loader used
 * by the embedded Pi session. Deliberately scope this to the project .agents
 * directory instead of surfacing TIA's global skills.
 */
export const listProjectSkills = (cwd = process.cwd()): ProjectSkill[] => {
  const directory = agentsSkillsDirectory(cwd);
  if (!existsSync(directory)) return [];

  const { skills } = loadSkillsFromDir({
    dir: directory,
    source: "tia-code-project-agents",
  });

  return skills
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: relative(cwd, skill.filePath) || join(".agents", "skills"),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
};
