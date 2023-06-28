import { ContentScript } from 'cozy-clisk/dist/contentscript'
import { format } from 'date-fns'
import Minilog from '@cozy/minilog'
const log = Minilog('ContentScript')
Minilog.enable('gaztarifreglementeCCC')

const DEFAULT_SOURCE_ACCOUNT_IDENTIFIER = 'gaz tarif reglemente'
const BASE_URL = 'https://gaz-tarif-reglemente.fr/'
const LOGIN_URL = `${BASE_URL}login-page.html`
class TemplateContentScript extends ContentScript {
  // ////////
  // PILOT //
  // ////////
  async navigateToLoginForm() {
    this.log('info', 'navigateToLoginForm starts')
    await this.goto(LOGIN_URL)
    // Connected or not, the form login will be found
    await this.waitForElementInWorker('#login-form')
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
      '#engie_fournisseur_d_electricite_et_de_gaz_naturel_quickaccessv3_la_fin_des_tarifs_reglementes_du_gaz'
    )
  }

  async ensureAuthenticated() {
    this.log('info', 'ensureAuthenticated starts')
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
      'a[href="/content/engie-tr/particuliers/espace-client-tr/profil-et-contrats.html"]'
    )
    await this.runInWorker(
      'click',
      'a[href="/content/engie-tr/particuliers/espace-client-tr/profil-et-contrats.html"]'
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
    await this.saveIdentity(this.store.userIdentity)
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
    await this.runInWorker(
      'click',
      'a[href="/content/engie-tr/particuliers/espace-client-tr/factures-et-paiements.html"]'
    )
    await this.waitForElementInWorker('#factures-listeFacture')
    await this.runInWorker('getUserDatas')
    await this.saveBills(this.store.bills, {
      context,
      keys: ['vendorRef'],
      contentType: 'application/pdf',
      fileIdAttributes: ['filename'],
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
    const loginField = document.querySelector('#email')
    const passwordField = document.querySelector('#motdepasse')
    if (loginField && passwordField) {
      const userCredentials = await this.findAndSendCredentials.bind(this)(
        loginField,
        passwordField
      )
      this.log('debug', 'Sendin userCredentials to Pilot')
      this.sendToPilot({
        userCredentials
      })
    }
    if (
      document.location.href.includes('espace-client-tr/synthese.html') &&
      document.querySelector('#header-deconnexion')
    ) {
      this.log('debug', 'Auth Check succeeded')
      return true
    }
    return false
  }

  async findAndSendCredentials(login, password) {
    this.log('debug', 'Starting findAndSendCredentials')
    let userLogin = login.value
    let userPassword = password.value
    const userCredentials = {
      login: userLogin,
      password: userPassword
    }
    return userCredentials
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

  async getUserDatas() {
    this.log('debug', 'Starting getUserDatas')
    let bills = []
    const timestamp = Math.round(new Date().getTime() / 1000)
    const creatStartInterval = new Date()
    creatStartInterval.setFullYear(2000)
    const formattedStartInterval = creatStartInterval.toISOString().slice(0, 10)
    const endInterval = new Date().toISOString().slice(0, 10)
    const foundBills = await window
      .fetch(
        `https://gaz-tarif-reglemente.fr/digitaltr-facture/api/private/facturesarchives?dateDebutIntervalle=${formattedStartInterval}T14%3A10%3A39.596Z&dateFinIntervalle=${endInterval}T14%3A10%3A39.596Z&_=${timestamp}`
      )
      .then(res => res.json())
    for (let bill of foundBills.listeFactures) {
      const amount = bill.montantTTC.montant
      const currency = '€'
      const documentType = bill.libelle
      const billDate = new Date(bill.dateFacture)
      const formattedDate = format(billDate, 'dd_MM_yyyy')
      const vendorRef = bill.numeroFacture
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
        fileurl: `https://gaz-tarif-reglemente.fr/digitaltr-util/api/private/document/mobile/attachment/${doubleEncodedFileHref}/SAE/${formattedDate.replace(
          /_/g,
          ''
        )}-${doubleEncodedNumber}.pdf?`,
        filename: `${formattedDate}_Gaz-tarif-reglemente_${amount}${currency}.pdf`,
        documentType,
        date: billDate,
        vendor: 'Gaz Tarif Réglementé',
        vendorRef,
        fileAttributes: {
          metadata: {
            contentAuthor: 'gaz tarif réglementé',
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
    await this.sendToPilot({ bills })
  }

  async checkWelcomeMessage() {
    this.log('info', 'checkWelcomeMessage starts')
    if (
      document.querySelector('.c-headerCelUser__name').textContent.length > 0 &&
      document.querySelector('.contrat-en-cours').textContent.length > 0
    )
      return true
    else return false
  }

  async checkIfFullfilled() {
    function sortTruthy(value) {
      return value.length > 0
    }
    const neededInfos = [
      document.querySelector('#idEmailContact_Infos').textContent,
      document.querySelector('#ProfilConsulterAdresseFacturation_nomComplet')
        .textContent,
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
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const connector = new TemplateContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'getUserIdentity',
      'getUserDatas',
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
