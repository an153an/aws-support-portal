const {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
} = require('@aws-sdk/client-cognito-identity-provider');
const { CognitoJwtVerifier } = require('aws-jwt-verify');

// Roles are Cognito groups, listed lowest to highest privilege.
const ROLES = ['customer', 'agent', 'admin'];

const poolId = process.env.COGNITO_USER_POOL_ID;
const clientId = process.env.COGNITO_CLIENT_ID;
const cognito = new CognitoIdentityProviderClient({});
const verifier = poolId && clientId
  ? CognitoJwtVerifier.create({ userPoolId: poolId, tokenUse: 'id', clientId })
  : null;

class AuthError extends Error {}

function requireConfigured() {
  if (!verifier) throw new AuthError('Authentication is not configured (COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID missing).');
}

// The highest-privilege group a user belongs to wins; no group means customer.
function roleFromGroups(groups = []) {
  return ROLES.reduce((best, r) => (groups.includes(r) ? r : best), 'customer');
}

// Exchanges email + password for a Cognito ID token and returns the user it describes.
async function login(email, password) {
  requireConfigured();
  let result;
  try {
    result = await cognito.send(new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: clientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }));
  } catch (err) {
    if (['NotAuthorizedException', 'UserNotFoundException'].includes(err.name)) {
      throw new AuthError('Incorrect email or password.');
    }
    throw err;
  }
  if (!result.AuthenticationResult) throw new AuthError('Additional sign-in steps are required for this account; contact an admin.');
  const claims = await verifier.verify(result.AuthenticationResult.IdToken);
  return {
    sub: claims.sub,
    email: claims.email,
    name: claims.name || claims.email,
    role: roleFromGroups(claims['cognito:groups']),
  };
}

// Self-service sign-up: creates a confirmed customer account. The admin API is
// used (rather than SignUp) so no email-verification step is needed.
async function register(name, email, password) {
  requireConfigured();
  try {
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: email,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: name },
      ],
    }));
    await cognito.send(new AdminSetUserPasswordCommand({
      UserPoolId: poolId, Username: email, Password: password, Permanent: true,
    }));
  } catch (err) {
    if (err.name === 'UsernameExistsException') throw new AuthError('An account with that email already exists.');
    if (err.name === 'InvalidPasswordException') throw new AuthError(err.message.replace(/^.*: /, ''));
    throw err;
  }
  await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: poolId, Username: email, GroupName: 'customer' }));
}

// Moves a user into exactly one role group.
async function setRole(email, role) {
  requireConfigured();
  if (!ROLES.includes(role)) throw new AuthError('Unknown role.');
  for (const other of ROLES.filter((r) => r !== role)) {
    await cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: poolId, Username: email, GroupName: other }));
  }
  await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: poolId, Username: email, GroupName: role }));
}

// ---- Express middleware ----
function attachUser(req, res, next) {
  res.locals.user = req.session.user || null;
  req.user = res.locals.user;
  next();
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  const target = req.method === 'GET' ? `?next=${encodeURIComponent(req.originalUrl)}` : '';
  res.redirect(`/login${target}`);
}

function requireRole(...allowed) {
  return (req, res, next) => {
    if (req.user && allowed.includes(req.user.role)) return next();
    res.status(403).render('error', { title: 'Not allowed', message: 'You do not have permission to do that.' });
  };
}

const isStaff = (user) => !!user && (user.role === 'agent' || user.role === 'admin');

module.exports = { ROLES, AuthError, roleFromGroups, login, register, setRole, attachUser, requireLogin, requireRole, isStaff };
