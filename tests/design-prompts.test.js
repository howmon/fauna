import { describe, expect, it } from 'vitest';
import {
  buildDesignTaskContext,
  buildProjectDesignContext,
  composeDesignPrompt,
  isConcreteDesignTask,
} from '../design-prompts.js';

describe('buildProjectDesignContext()', () => {
  it('activates the design prompt for projects configured in Design Settings', () => {
    const context = buildProjectDesignContext({
      name: 'Quarterly reporting',
      design: {
        systemId: 'default',
        directionId: 'editorial-monocle',
        fidelity: 'hi',
        platform: 'desktop',
      },
    });

    expect(context).toContain('## Designer Identity');
    expect(context).toContain('Project: Quarterly reporting');
    expect(context).toContain('Visual Direction: Editorial / Print');
    expect(context).toContain('Fidelity: high (pixel-ready)');
    expect(context).toContain('fauna_design_audit');
    expect(context).toContain('at most two visual audit passes');
  });

  it('does not force design mode for projects with brand preferences only', () => {
    const context = buildProjectDesignContext({
      name: 'Application',
      design: {
        lane: 'product',
        voice: 'quiet and precise',
        colors: { accent: '#0f766e' },
      },
    });

    expect(context).toBe('');
  });
});

describe('composeDesignPrompt()', () => {
  it('rejects traversal-like catalog identifiers', () => {
    const context = composeDesignPrompt({
      skillId: '../../private',
      systemId: '../secrets',
      projectName: 'Safe project',
    });

    expect(context).not.toContain('../../private');
    expect(context).not.toContain('../secrets');
    expect(context).toContain('Project: Safe project');
  });
});

describe('automatic design-task activation', () => {
  it('activates for concrete design implementation requests', () => {
    expect(isConcreteDesignTask('Build an executive KPI dashboard for a manufacturing team.')).toBe(true);
    expect(isConcreteDesignTask('Create a 12-slide quarterly performance deck.')).toBe(true);
    expect(buildDesignTaskContext(null, 'Design a dense cybersecurity infographic.'))
      .toContain('## Designer Identity');
  });

  it('does not activate for conceptual questions or ordinary code work', () => {
    expect(isConcreteDesignTask('Can Fauna learn to design dashboards?')).toBe(false);
    expect(isConcreteDesignTask('Explain how the dashboard query is cached.')).toBe(false);
    expect(buildDesignTaskContext(null, 'Fix the authentication test.')).toBe('');
  });
});