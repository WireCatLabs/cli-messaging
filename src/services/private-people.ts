import { pickPerson } from "../resolve.js"
import type { ServiceDeps } from "./deps.js"

export const privatePeopleService = (deps: ServiceDeps) => {
  const target = async (reference: string) => {
    const store = await deps.store()
    const account = await deps.account()
    const person = pickPerson(reference, await store.people(account.provider, { account: account.account }))
    return { store, account, person }
  }
  return {
    show: async (reference: string) => {
      const { store, account, person } = await target(reference)
      return store.privateContact(account, person.id)
    },
    alias: async (reference: string, alias: string | null) => {
      const { store, account, person } = await target(reference)
      return store.setContactAlias(account, person.id, alias)
    },
    add: async (reference: string, text: string) => {
      const { store, account, person } = await target(reference)
      return store.addContactNote(account, person.id, text)
    },
    note: async (reference: string, id: string) => {
      const { store, account, person } = await target(reference)
      return store.contactNote(account, person.id, id)
    },
    edit: async (reference: string, id: string, text: string, revision: number) => {
      const { store, account, person } = await target(reference)
      return store.editContactNote(account, person.id, id, text, revision)
    },
    remove: async (reference: string, id: string) => {
      const { store, account, person } = await target(reference)
      return store.removeContactNote(account, person.id, id)
    },
  }
}
