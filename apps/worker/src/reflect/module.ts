import { defineModule } from '@swirls/looms/core'

import { friction } from './friction'
import { activePlaybook, createPlaybookThread, playbookDefinition } from './playbook'
import { reflectModule } from './scope'
import { proposeLesson, retireLesson } from './signals'

export function reflect() {
  return defineModule(reflectModule, () => ({
    definitions: [playbookDefinition],
    threads: {
      'reflect-playbook': createPlaybookThread(),
    },
    projections: {
      friction,
      activePlaybook,
    },
    signals: {
      proposeLesson,
      retireLesson,
    },
  }))
}

export { proposeLesson, retireLesson, friction, activePlaybook, playbookDefinition }
