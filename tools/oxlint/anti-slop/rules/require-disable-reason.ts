import { defineRule } from '@oxlint/plugins'

/** `oxlint-disable…` or `eslint-disable…`, then the rules, then what must follow them. */
const directive = /^\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?\b(?<rest>.*)$/su

/**
 * Require every lint disable directive to name its rules and say why after `--`.
 * A disable is the one way past a rule, so it has to be specific and reviewable.
 */
export const requireDisableReasonRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require lint disable directives to name the rules they disable and give a reason after `--`.',
    },
    messages: {
      noRules: 'Name the rules this directive disables; a bare disable turns off every rule.',
      noReason: 'Say why after ` -- `: what makes this case safe, or what the rule cannot see.',
    },
  },
  createOnce(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const rest = directive.exec(comment.value)?.groups?.rest

          if (rest === undefined) {
            continue
          }

          const [rules = '', reason] = rest.split(/\s--\s/u, 2)

          if (rules.trim() === '') {
            context.report({ node: comment, messageId: 'noRules' })
          } else if (reason === undefined || reason.trim().length < 10) {
            context.report({ node: comment, messageId: 'noReason' })
          }
        }
      },
    }
  },
})
