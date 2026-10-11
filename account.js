document.querySelector('#account-logout').addEventListener('click', async () => {
  try {
    await postApi('/api/auth/logout', {});
    location.assign('/');
  } catch (error) {
    showAuthMessage(document.querySelector('#account-message'), error.message);
  }
});
