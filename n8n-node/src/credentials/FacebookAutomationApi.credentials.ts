import {
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';

export class FacebookAutomationApi implements ICredentialType {
  name = 'facebookAutomationApi';
  displayName = 'Facebook Automation API';
  documentationUrl = 'https://github.com/your-repo/facebook-automation';
  properties: INodeProperties[] = [
    {
      displayName: 'API URL',
      name: 'apiUrl',
      type: 'string',
      default: 'http://localhost:3000',
      placeholder: 'http://facebook-automation:3000',
      description: 'The URL of the Facebook Automation Docker Service',
      required: true,
    },
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: {
        password: true,
      },
      default: '',
      description: 'API Key for authentication',
      required: true,
    },
    {
      displayName: 'Session Name',
      name: 'sessionName',
      type: 'string',
      default: 'default',
      description: 'Name of the session to use (for multi-account support)',
      required: true,
    },
    {
      displayName: 'Facebook Cookies (JSON)',
      name: 'cookiesJson',
      type: 'string',
      typeOptions: {
        password: true,
        rows: 10,
      },
      default: '',
      description: 'Facebook cookies exported as JSON. Supports Chrome Export, EditThisCookie, Playwright Storage State, and Puppeteer Cookie Array formats.',
      required: true,
    },
    {
      displayName: 'Proxy (Optional)',
      name: 'proxy',
      type: 'string',
      default: '',
      placeholder: 'http://user:pass@proxy:port',
      description: 'Optional proxy server URL',
    },
    {
      displayName: 'User Agent (Optional)',
      name: 'userAgent',
      type: 'string',
      default: '',
      placeholder: 'Mozilla/5.0 ...',
      description: 'Optional custom User-Agent string',
    },
  ];
}
