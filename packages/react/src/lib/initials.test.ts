import { describe, expect, test } from 'bun:test'

import { initials } from './initials'

describe('initials', () => {
  test('uses the first and last word', () => {
    expect(initials('Aleksandra Wiśniewska-Kowalczyk')).toBe('AW')
    expect(initials('María José de la Cruz y Fernández')).toBe('MF')
    expect(initials('  Sam   Lee ')).toBe('SL')
  })

  test('leaves out suffixes', () => {
    expect(initials('Christopher Alexander Montgomery III')).toBe('CM')
  })

  test('handles one word, lowercase and scripts without spaces', () => {
    expect(initials('Jo')).toBe('J')
    expect(initials('dana')).toBe('D')
    expect(initials('王秀英')).toBe('王')
    expect(initials('Ólafur Darri Ólafsson')).toBe('ÓÓ')
  })

  test('shows an emoji-first name as the emoji alone', () => {
    expect(initials('🦊 Fox')).toBe('🦊')
    expect(initials('👩🏽‍💻 Priya')).toBe('👩🏽‍💻')
  })

  test('reads an email address by its local part', () => {
    expect(initials('bartholomew.fitzgerald@northwind-industries-holdings.example.com')).toBe('BF')
    expect(initials('a@b.co')).toBe('A')
  })

  test('returns nothing without a name', () => {
    expect(initials(undefined)).toBe('')
    expect(initials('   ')).toBe('')
  })
})
