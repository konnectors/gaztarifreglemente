import { ContentScript } from 'cozy-clisk/dist/contentscript'
import { format } from 'date-fns'
import waitFor from 'p-wait-for'
import Minilog from '@cozy/minilog'
const log = Minilog('ContentScript')
Minilog.enable('gazpasserelleCCC')

const DEFAULT_SOURCE_ACCOUNT_IDENTIFIER = 'gaz passerelle engie'
const BASE_URL = 'https://gazpasserelle.engie.fr/'
const LOGIN_URL = `${BASE_URL}login-page.html`
class TemplateContentScript extends ContentScript {
  // ////////
  // PILOT //
  // ////////

  async onWorkerEvent({ event, payload }) {
    if (event === 'loginSubmit') {
      const { login, password } = payload || {}
      if (login && password) {
        this.store.userCredentials = { login, password }
      } else {
        this.log('warn', 'Did not manage to intercept credentials')
      }
    }
  }

  async onWorkerReady() {
    function addClickListener() {
      document.body.addEventListener('click', e => {
        const clickedElementId = e.target.getAttribute('id')
        if (clickedElementId === 'login-btn') {
          const login = document.querySelector(`#email`)?.value
          const password = document.querySelector('#motdepasse')?.value
          this.bridge.emit('workerEvent', {
            event: 'loginSubmit',
            payload: { login, password }
          })
        }
      })
    }
    await this.waitForElementNoReload('#email')
    await this.waitForElementNoReload('#motdepasse')
    if (
      !(await this.checkForElement('#checkboxMat')) &&
      (await this.checkForElement('#motdepasse'))
    ) {
      this.log(
        'warn',
        'Cannot find the rememberMe checkbox, logout might not work as expected'
      )
    } else {
      const checkBox = document.querySelector('#checkboxMat')
      // Setting the visibility to hidden on the parent to make the element disapear
      // preventing users to click it
      checkBox.parentNode.parentNode.style.visibility = 'hidden'
    }
    this.log('info', 'password element found, adding listener')
    addClickListener.bind(this)()
  }

  async navigateToLoginForm() {
    this.log('info', 'navigateToLoginForm starts')
    await this.goto(LOGIN_URL)
    // Connected or not, the form login will be found
    await Promise.all([
      this.waitForElementInWorker('#login-form'),
      // This is the selector for the chatBot element, it always appears amongst the last loaded elements
      this.waitForElementInWorker('#cai-webchat-div')
    ])
  }

  async ensureNotAuthenticated() {
    this.log('info', 'ensureNotAuthenticated starts')
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkActiveSession')
    if (!authenticated) {
      this.log('info', 'Not auth, returning true')
      return true
    }
    this.log('info', 'Already logged, logging out')
    await this.runInWorker('click', '#headerDeconnexionBtnMobile')
    await this.waitForElementInWorker(
      '#engie_fournisseur_d_electricite_et_de_gaz_naturel_quickaccessv3_contrat_gaz_passerelle'
    )
    const foundMainUrl = await this.evaluateInWorker(function checkMainUrl() {
      return document.location.href === 'https://gazpasserelle.engie.fr/'
    })
    if (foundMainUrl) {
      this.log('info', 'Logged out')
    }
    this.log('error', 'Something went unexpected after log out')
  }

  async ensureAuthenticated({ account }) {
    this.log('info', 'ensureAuthenticated starts')
    this.bridge.addEventListener('workerEvent', this.onWorkerEvent.bind(this))
    if (!account) {
      await this.ensureNotAuthenticated()
    }
    await this.navigateToLoginForm()
    const credentials = await this.getCredentials()
    if (credentials) {
      this.log('info', 'Credentials found')
      await this.authWithCredentials(credentials)
    } else {
      this.log('info', 'No credentials found')
      await this.authWithoutCredentials()
    }
  }

  async authWithCredentials(credentials) {
    this.log('debug', 'Starting authWithCredentials')
    if (await this.isElementInWorker('#view-mode-connecte-sans-ec')) {
      const isActive = await this.checkSession()
      if (isActive) {
        await this.clickAndWait(
          '#lien-selectionner-reference-client',
          '#header-deconnexion'
        )
        return true
      }
    }
    const isSuccess = await this.autoLogin(credentials)
    if (isSuccess) {
      return true
    } else {
      this.log('debug', 'Something went wrong while autoLogin, new auth needed')
      this.waitForUserAuthentication()
    }
  }

  async authWithoutCredentials() {
    this.log('debug', 'Starting authWithoutCredentials')
    await this.waitForElementInWorker('#login-form')
    await this.waitForElementInWorker('#email')
    await this.waitForUserAuthentication()
  }

  async waitForUserAuthentication() {
    this.log('debug', 'waitForUserAuthentication starts')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({ method: 'waitForAuthenticated' })
    await this.setWorkerState({ visible: false })
  }

  async getUserDataFromWebsite() {
    this.log('debug', 'Starting getUserDataFromWebsite')
    await this.waitForElementInWorker('.c-headerCelUser__name')
    await this.runInWorkerUntilTrue({ method: 'checkWelcomeMessage' })
    await this.waitForElementInWorker(
      'a[href="/espace-client/profil-et-contrats.html"]'
    )
    await this.runInWorker(
      'click',
      'a[href="/espace-client/profil-et-contrats.html"]'
    )
    await this.waitForElementInWorker('.c-headerCelUser__name')
    await this.runInWorkerUntilTrue({ method: 'checkWelcomeMessage' })
    await Promise.all([
      this.waitForElementInWorker('#idEmailContact_Infos'),
      this.waitForElementInWorker(
        '#ProfilConsulterAdresseFacturation_nomComplet'
      ),
      this.waitForElementInWorker('#ProfilConsulterAdresseFacturation_adresse'),
      this.waitForElementInWorker(
        '#ProfilConsulterAdresseFacturation_complementAdresse'
      ),
      this.waitForElementInWorker('#ProfilConsulterAdresseFacturation_commune'),
      this.waitForElementInWorker('#idNumerosTelephone_Infos')
    ])
    // After receiving needed elements, we're checking if everything's fine for scraping
    await this.runInWorkerUntilTrue({
      method: 'checkIfFullfilled',
      timeout: 30000
    })
    await this.runInWorker('getUserIdentity')
    return {
      sourceAccountIdentifier: this.store.userIdentity.email
        ? this.store.userIdentity.email
        : DEFAULT_SOURCE_ACCOUNT_IDENTIFIER
    }
  }

  async fetch(context) {
    this.log('debug', 'Starting fetch')
    if (this.store.userCredentials) {
      await this.saveCredentials(this.store.userCredentials)
    }
    if (this.store.userIdentity) {
      await this.saveIdentity({ contact: this.store.userIdentity })
    }
    await this.runInWorker(
      'click',
      'a[href="/espace-client/factures-et-paiements.html"]'
    )
    await this.waitForElementInWorker('#factures-listeFacture')
    const bills = await this.runInWorker('getBills')
    await this.saveBills(bills, {
      context,
      keys: ['vendorRef'],
      contentType: 'application/pdf',
      fileIdAttributes: ['vendorRef'],
      qualificationLabel: 'energy_invoice'
    })
  }
  async checkSession() {
    this.log('debug', 'Starting checkSession')
    /*
     * Here we wait for 3 secondes as the website could be a bit long to make the form interactive.
     * It may be present but not visible yet despite CSS is not actually hidding it,
     * the website take some times to apply the hidden class if it needs one.
     * It seems like there's no request sent login-form related to modify its class or anything else we could intercept to ensure the page wont change.
     * Cookies are no help too as the token or the refresh token are still present in the case of an active
     * session AND in case of a new auth needed. This sleep is for now the only way to ensure that nothing will change before executing
     * the rest of the connector's code and know in wich scenario we are in at the moment as there is ALWAYS a form
     * in the page, either scenarios (session or new auth).
     * It has been discuss and agreed to keep it that way even if it's clearly not recommended.
     */
    await sleep(3000)
    const isFormInvisble = await this.runInWorker('checkActiveSession')
    if (isFormInvisble) {
      return true
    } else {
      return false
    }
  }

  async autoLogin(credentials) {
    this.log('info', 'AutoLogin starts')
    await Promise.all([
      this.waitForElementInWorker('#email'),
      this.waitForElementInWorker('#motdepasse'),
      this.waitForElementInWorker('#login-btn')
    ])
    await this.runInWorker('handleForm', credentials)
    const isLoginFailed = await this.runInWorker('checkLoginFail')
    if (isLoginFailed) return false
    else return true
  }

  // ////////
  // WORKER//
  // ////////

  async checkAuthenticated() {
    this.log('debug', 'Starting checkAuthenticated')
    if (
      document.location.href.includes('espace-client/synthese.html') &&
      document.querySelector('#header-deconnexion')
    ) {
      this.log('debug', 'Auth Check succeeded')
      return true
    }
    return false
  }

  async getUserIdentity() {
    const email = document.querySelector('#idEmailContact_Infos').innerHTML
    const rawFullName = document.querySelector(
      '#ProfilConsulterAdresseFacturation_nomComplet'
    ).innerHTML
    const { [1]: firstName, [2]: lastName } = rawFullName.split(' ')
    const street = document.querySelector(
      '#ProfilConsulterAdresseFacturation_adresse'
    ).innerHTML
    const addressComplement = document.querySelector(
      '#ProfilConsulterAdresseFacturation_complementAdresse'
    ).innerHTML
    const [postCode, city] = document
      .querySelector('#ProfilConsulterAdresseFacturation_commune')
      .innerHTML.split(' ')
    const phoneNumber = document
      .querySelector('#idNumerosTelephone_Infos')
      .innerHTML.replace(/\./g, '')
    let userIdentity = {
      email,
      name: {
        firstName,
        lastName,
        fullName: `${firstName} ${lastName}`
      },
      address: [
        {
          street,
          postCode,
          city
        }
      ],
      phone: [
        {
          type: phoneNumber.match(/^06|07|\+336|\+337/g) ? 'mobile' : 'home',
          number: phoneNumber
        }
      ]
    }
    if (addressComplement !== 'Etage : .') {
      userIdentity.address[0].addressComplement = addressComplement
      userIdentity.address[0].fullAddress = `${street} ${addressComplement} ${postCode} ${city}`
    }
    if ((addressComplement === 'Etage : .') | null | undefined) {
      userIdentity.address[0].fullAddress = `${street} ${postCode} ${city}`
    }
    await this.sendToPilot({ userIdentity })
  }

  async getBills() {
    this.log('debug', 'Starting getBills')
    let bills = []
    let foundBills = []
    await this.waitForSessionStorage()
    const refBP = window.sessionStorage.getItem('CEL_REFBP')
    const billsJSON = JSON.parse(
      window.sessionStorage.getItem('CEL_MOM_FACTURES')
    )
    const allBills = billsJSON[`${refBP}`]
    const allBillsEntries = Object.keys(billsJSON[`${refBP}`])
    for (const billsEntry of allBillsEntries) {
      if (!allBills[billsEntry]) {
        continue
      }
      const fullObject = allBills[billsEntry]
      const values = Object.values(fullObject)
      values.forEach(value => foundBills.push(value))
    }
    for (let bill of foundBills) {
      const amount = bill.montant
      const currency = '€'
      const documentType = bill.libelle
      const billDate = new Date(bill.dateFacture)
      const formattedDate = format(billDate, 'dd_MM_yyyy')
      const vendorRef = bill.id
      const decodeFileHref = `${decodeURIComponent(bill.url)}`
      const doubleEncodedFileHref = encodeURIComponent(
        encodeURIComponent(decodeFileHref)
      )
      const doubleEncodedNumber = encodeURIComponent(
        encodeURIComponent(`N°${vendorRef}`)
      )
      const computedBill = {
        amount,
        currency,
        fileurl: `https://gazpasserelle.engie.fr/digitaltr-util/api/private/document/mobile/attachment/${doubleEncodedFileHref}/SAE/${formattedDate.replace(
          /_/g,
          ''
        )}-${doubleEncodedNumber}.pdf?`,
        filename: `${formattedDate}_Gaz-Passerelle-Engie_${amount}${currency}.pdf`,
        documentType,
        date: billDate,
        vendor: 'Gaz Passerelle Engie',
        vendorRef,
        fileAttributes: {
          metadata: {
            contentAuthor: 'gaz passerelle',
            datetime: billDate,
            datetimeLabel: 'issueDate',
            isSubscription: true,
            issueDate: new Date(),
            carbonCopy: true
          }
        }
      }
      bills.push(computedBill)
    }
    return bills
  }

  async checkWelcomeMessage() {
    this.log('info', 'checkWelcomeMessage starts')
    await waitFor(
      () => {
        if (
          document.querySelector('.c-headerCelUser__name').textContent.length >
            0 &&
          document.querySelector('.contrat-en-cours').textContent.length > 0
        ) {
          document.querySelector('.c-headerCelUser__name').remove()
          return true
        } else return false
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
    return true
  }

  async checkIfFullfilled() {
    await waitFor(
      () => {
        function sortTruthy(value) {
          return value.length > 0
        }
        const neededInfos = [
          document.querySelector('#idEmailContact_Infos').textContent,
          document.querySelector(
            '#ProfilConsulterAdresseFacturation_nomComplet'
          ).textContent,
          document.querySelector('#ProfilConsulterAdresseFacturation_adresse')
            .textContent,
          document.querySelector(
            '#ProfilConsulterAdresseFacturation_complementAdresse'
          ).textContent,
          document.querySelector('#ProfilConsulterAdresseFacturation_commune')
            .textContent,
          document.querySelector('#idNumerosTelephone_Infos').textContent
        ]
        const truthyInfos = neededInfos.filter(sortTruthy)

        if (truthyInfos.length === neededInfos.length) {
          return true
        }
        return false
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
    return true
  }

  async checkActiveSession() {
    this.log('debug', 'Starting checkActiveSession')
    const formIsInvisible = document
      .querySelector('#view-mode-non-connecte')
      .getAttribute('class')
      .includes('u-hide')
    if (formIsInvisible) {
      return true
    } else {
      return false
    }
  }

  async handleForm(credentials) {
    this.log('debug', 'Starting handleForm')
    const loginElement = document.querySelector('input[id="email"]')
    const passwordElement = document.querySelector('input[id="motdepasse"]')
    const submitButton = document.querySelector('button[id="login-btn"]')

    loginElement.value = credentials.login
    passwordElement.value = credentials.password
    if (loginElement.value.length > 0 && passwordElement.value.length > 0) {
      this.log('info', 'Login and password fullfilled')
      submitButton.click()
      return true
    } else {
      this.log('warn', 'something went wrong while filling values')
      return false
    }
  }

  async checkLoginFail() {
    const errorElement = document
      .querySelector('#js-login-global-error')
      .getAttribute('data-marquage_info')
    if (errorElement !== null) return true
    else return false
  }

  async waitForSessionStorage() {
    await waitFor(
      () => {
        const result = Boolean(
          window.sessionStorage.getItem('CEL_MOM_FACTURES')
        )
        return result
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const connector = new TemplateContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'getUserIdentity',
      'getBills',
      'checkIfFullfilled',
      'checkWelcomeMessage',
      'checkActiveSession',
      'handleForm',
      'checkLoginFail',
      'navigateToLoginForm'
    ]
  })
  .catch(err => {
    log.warn(err)
  })
